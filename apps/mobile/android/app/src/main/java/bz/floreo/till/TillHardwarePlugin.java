package bz.floreo.till;

import android.Manifest;
import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothSocket;
import android.content.Context;
import android.os.Build;
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
