package bz.floreo.till;

import android.Manifest;
import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothSocket;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Receipt printers for the till (web/src/pos/platform.ts, TillHardware):
 * raw ESC/POS bytes to network printers (port 9100) on the local network,
 * and to paired Bluetooth printers over the serial port profile.
 *
 * Also the till's secrets (its token, the key of its local data): encrypted
 * with an AES key kept in the Android Keystore, which never leaves it.
 */
@CapacitorPlugin(
    name = "TillHardware",
    permissions = { @Permission(alias = "bluetooth", strings = { Manifest.permission.BLUETOOTH_CONNECT }) }
)
public class TillHardwarePlugin extends Plugin {

    /** The Bluetooth serial port profile, which receipt printers use. */
    private static final UUID SERIAL_PORT = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");
    /** One print at a time, off the main thread. */
    private final ExecutorService printing = Executors.newSingleThreadExecutor();

    @PluginMethod
    public void sendNetwork(PluginCall call) {
        String host = call.getString("host");
        int port = call.getInt("port", 9100);
        byte[] bytes = decode(call);
        if (host == null || bytes == null) return;
        printing.execute(() -> {
            try {
                InetAddress address = InetAddress.getByName(host.trim());
                if (!(address.isSiteLocalAddress() || address.isLinkLocalAddress() || address.isLoopbackAddress())) {
                    call.reject(host + " is not on the local network");
                    return;
                }
                try (Socket socket = new Socket()) {
                    socket.connect(new InetSocketAddress(address, port), 5000);
                    socket.setSoTimeout(8000);
                    OutputStream out = socket.getOutputStream();
                    out.write(bytes);
                    out.flush();
                }
                call.resolve();
            } catch (Exception e) {
                call.reject("Could not print to " + host + ":" + port + ". Is the printer on and on this network? (" + e.getMessage() + ")");
            }
        });
    }

    @PluginMethod
    public void listBluetooth(PluginCall call) {
        if (needsPermission()) {
            requestPermissionForAlias("bluetooth", call, "listAfterPermission");
            return;
        }
        list(call);
    }

    @PermissionCallback
    private void listAfterPermission(PluginCall call) {
        if (needsPermission()) call.reject("Allow Bluetooth (Nearby devices) to find printers");
        else list(call);
    }

    @PluginMethod
    public void sendBluetooth(PluginCall call) {
        if (needsPermission()) {
            requestPermissionForAlias("bluetooth", call, "sendAfterPermission");
            return;
        }
        send(call);
    }

    @PermissionCallback
    private void sendAfterPermission(PluginCall call) {
        if (needsPermission()) call.reject("Allow Bluetooth (Nearby devices) to print");
        else send(call);
    }

    private boolean needsPermission() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && getPermissionState("bluetooth") != PermissionState.GRANTED;
    }

    private BluetoothAdapter adapter(PluginCall call) {
        BluetoothManager manager = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
        BluetoothAdapter adapter = manager == null ? null : manager.getAdapter();
        if (adapter == null) {
            call.reject("This device has no Bluetooth");
            return null;
        }
        if (!adapter.isEnabled()) {
            call.reject("Turn Bluetooth on");
            return null;
        }
        return adapter;
    }

    @SuppressLint("MissingPermission")
    private void list(PluginCall call) {
        BluetoothAdapter adapter = adapter(call);
        if (adapter == null) return;
        JSArray devices = new JSArray();
        for (BluetoothDevice d : adapter.getBondedDevices()) {
            JSObject o = new JSObject();
            o.put("name", d.getName() == null ? d.getAddress() : d.getName());
            o.put("address", d.getAddress());
            devices.put(o);
        }
        JSObject result = new JSObject();
        result.put("devices", devices);
        call.resolve(result);
    }

    @SuppressLint("MissingPermission")
    private void send(PluginCall call) {
        String address = call.getString("address");
        byte[] bytes = decode(call);
        if (bytes == null) return;
        if (address == null || !BluetoothAdapter.checkBluetoothAddress(address)) {
            call.reject("Choose the Bluetooth printer again");
            return;
        }
        BluetoothAdapter adapter = adapter(call);
        if (adapter == null) return;
        printing.execute(() -> {
            BluetoothSocket socket = null;
            try {
                adapter.cancelDiscovery();
                socket = adapter.getRemoteDevice(address).createRfcommSocketToServiceRecord(SERIAL_PORT);
                socket.connect();
                OutputStream out = socket.getOutputStream();
                out.write(bytes);
                out.flush();
                // Give the printer time to take everything before the link closes.
                Thread.sleep(Math.min(3000, 300 + bytes.length / 16));
                call.resolve();
            } catch (Exception e) {
                call.reject("Could not print by Bluetooth. Is the printer on and paired? (" + e.getMessage() + ")");
            } finally {
                if (socket != null) {
                    try {
                        socket.close();
                    } catch (Exception ignored) {
                        // closing anyway
                    }
                }
            }
        });
    }

    // ---------- secrets ----------

    private static final String SECRET_KEY_ALIAS = "floreo-till-secrets";
    private static final String SECRET_PREFS = "floreo-till-secure";

    private SharedPreferences secrets() {
        return getContext().getSharedPreferences(SECRET_PREFS, Context.MODE_PRIVATE);
    }

    /** The Keystore key that encrypts the secrets (made once). */
    private SecretKey secretKey() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        KeyStore.Entry entry = store.getEntry(SECRET_KEY_ALIAS, null);
        if (entry instanceof KeyStore.SecretKeyEntry) return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(SECRET_KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build());
        return generator.generateKey();
    }

    @PluginMethod
    public void secretSet(PluginCall call) {
        String key = call.getString("key");
        String value = call.getString("value");
        if (key == null || value == null) {
            call.reject("Missing the key or the value");
            return;
        }
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, secretKey());
            byte[] sealed = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
            String stored = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + ":" + Base64.encodeToString(sealed, Base64.NO_WRAP);
            // commit, not apply: on the disk before the till goes on.
            if (!secrets().edit().putString(key, stored).commit()) {
                call.reject("Could not save the secret");
                return;
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not keep the secret: " + e.getMessage());
        }
    }

    @PluginMethod
    public void secretGet(PluginCall call) {
        String key = call.getString("key");
        if (key == null) {
            call.reject("Missing the key");
            return;
        }
        JSObject result = new JSObject();
        String stored = secrets().getString(key, null);
        if (stored == null || !stored.contains(":")) {
            result.put("value", JSONObject.NULL);
            call.resolve(result);
            return;
        }
        try {
            String[] parts = stored.split(":", 2);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, secretKey(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
            result.put("value", new String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8));
            call.resolve(result);
        } catch (Exception e) {
            // Sealed with a key this device no longer has (restored from a backup): as if there were none.
            result.put("value", JSONObject.NULL);
            call.resolve(result);
        }
    }

    @PluginMethod
    public void secretRemove(PluginCall call) {
        String key = call.getString("key");
        if (key == null) {
            call.reject("Missing the key");
            return;
        }
        secrets().edit().remove(key).commit();
        call.resolve();
    }

    private byte[] decode(PluginCall call) {
        String data = call.getString("data");
        if (data == null || data.isEmpty()) {
            call.reject("Nothing to print");
            return null;
        }
        try {
            return Base64.decode(data, Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            call.reject("Nothing to print");
            return null;
        }
    }
}
