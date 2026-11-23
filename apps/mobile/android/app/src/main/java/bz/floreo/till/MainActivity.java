package bz.floreo.till;

import android.os.Bundle;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The till's own plugin: network and Bluetooth receipt printers.
        registerPlugin(TillHardwarePlugin.class);
        super.onCreate(savedInstanceState);
        // A till stays awake while it is open.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }
}
