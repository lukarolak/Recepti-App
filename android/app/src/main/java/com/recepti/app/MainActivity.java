package com.recepti.app;

import android.app.AlertDialog;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.content.Context;
import android.content.DialogInterface;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.SharedPreferences;
import android.content.res.AssetManager;
import android.webkit.JsResult;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.appcompat.app.AppCompatActivity;
import java.net.HttpURLConnection;
import java.net.URL;
import java.io.*;

// Hosts the app entirely inside a WebView, backed by a Node/Express server (the same
// server.js used by the docker-compose deployment, bundled under assets/nodejs-project)
// that this activity starts on a background thread and talks to over 127.0.0.1 only --
// this app never needs to accept incoming connections from other devices.
public class MainActivity extends AppCompatActivity {

    private static final String SERVER_URL = "http://127.0.0.1:3000/";
    private static final String PING_URL = "http://127.0.0.1:3000/api/ping";

    static {
        System.loadLibrary("native-lib");
        System.loadLibrary("node");
    }

    // We just want one instance of node running in the background.
    public static boolean _startedNodeAlready = false;

    private WebView webView;
    private final Handler uiHandler = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        boolean isDebuggable = (getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        if (isDebuggable) {
            // Lets a desktop Chrome at chrome://inspect (or the raw CDP websocket via
            // `adb forward`) attach to this WebView -- console/network visibility a plain
            // logcat filter doesn't give us, since this WebView build doesn't otherwise
            // forward console.* or fetch() failures to logcat.
            WebView.setWebContentsDebuggingEnabled(true);
        }

        webView = findViewById(R.id.webview);
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                // Keep all navigation (links, form POST redirects) inside this WebView
                // instead of the default behavior of handing it off to an external browser.
                return false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                android.util.Log.d("ReceptiDebug", "onPageFinished: " + url);
            }

            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                android.util.Log.d("ReceptiDebug", "onReceivedError: " + errorCode + " " + description + " url=" + failingUrl);
            }
        });

        // Without a WebChromeClient, WebView's default onJsConfirm/onJsAlert implementation
        // shows nothing and confirm() just returns false immediately -- which silently
        // blocked every delete button's onsubmit="return confirm(...)" from ever submitting.
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onJsConfirm(WebView view, String url, String message, final JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                    .setMessage(message)
                    .setPositiveButton(android.R.string.ok, new DialogInterface.OnClickListener() {
                        @Override
                        public void onClick(DialogInterface dialog, int which) {
                            result.confirm();
                        }
                    })
                    .setNegativeButton(android.R.string.cancel, new DialogInterface.OnClickListener() {
                        @Override
                        public void onClick(DialogInterface dialog, int which) {
                            result.cancel();
                        }
                    })
                    .setOnCancelListener(new DialogInterface.OnCancelListener() {
                        @Override
                        public void onCancel(DialogInterface dialog) {
                            result.cancel();
                        }
                    })
                    .show();
                return true;
            }

            @Override
            public boolean onJsAlert(WebView view, String url, String message, final JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                    .setMessage(message)
                    .setPositiveButton(android.R.string.ok, new DialogInterface.OnClickListener() {
                        @Override
                        public void onClick(DialogInterface dialog, int which) {
                            result.confirm();
                        }
                    })
                    .setOnCancelListener(new DialogInterface.OnCancelListener() {
                        @Override
                        public void onCancel(DialogInterface dialog) {
                            result.confirm();
                        }
                    })
                    .show();
                return true;
            }
        });

        if (!_startedNodeAlready) {
            _startedNodeAlready = true;
            new Thread(new Runnable() {
                @Override
                public void run() {
                    String nodeDir = getApplicationContext().getFilesDir().getAbsolutePath() + "/nodejs-project";
                    if (wasAPKUpdated()) {
                        File nodeDirReference = new File(nodeDir);
                        if (nodeDirReference.exists()) {
                            deleteFolderRecursively(new File(nodeDir));
                        }
                        copyAssetFolder(getApplicationContext().getAssets(), "nodejs-project", nodeDir);
                        saveLastUpdateTime();
                    }
                    startNodeWithArguments(new String[]{"node", nodeDir + "/app/entry-android.js"});
                }
            }).start();
        }

        new Thread(new Runnable() {
            @Override
            public void run() {
                waitForServerAndLoad();
            }
        }).start();
    }

    // Polls the embedded server until it responds, then loads it into the WebView on
    // the UI thread. There's no fixed startup delay to guess at here -- node's own
    // require()/module-resolution time varies -- so poll instead of a blind sleep.
    private void waitForServerAndLoad() {
        android.util.Log.d("ReceptiDebug", "waitForServerAndLoad: starting poll loop");
        int attempts = 0;
        while (true) {
            attempts++;
            try {
                URL url = new URL(PING_URL);
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setConnectTimeout(300);
                conn.setReadTimeout(300);
                int code = conn.getResponseCode();
                conn.disconnect();
                android.util.Log.d("ReceptiDebug", "ping attempt " + attempts + " -> code " + code);
                if (code == 204) break;
            } catch (Exception e) {
                android.util.Log.d("ReceptiDebug", "ping attempt " + attempts + " -> exception " + e);
            }
            try {
                Thread.sleep(200);
            } catch (InterruptedException ie) {
                return;
            }
        }
        android.util.Log.d("ReceptiDebug", "ping succeeded, calling loadUrl");
        uiHandler.post(new Runnable() {
            @Override
            public void run() {
                android.util.Log.d("ReceptiDebug", "loadUrl(" + SERVER_URL + ") on UI thread now");
                webView.loadUrl(SERVER_URL);
            }
        });
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    public native Integer startNodeWithArguments(String[] arguments);

    private boolean wasAPKUpdated() {
        SharedPreferences prefs = getApplicationContext().getSharedPreferences("NODEJS_MOBILE_PREFS", Context.MODE_PRIVATE);
        long previousLastUpdateTime = prefs.getLong("NODEJS_MOBILE_APK_LastUpdateTime", 0);
        long lastUpdateTime = 1;
        try {
            PackageInfo packageInfo = getApplicationContext().getPackageManager().getPackageInfo(getApplicationContext().getPackageName(), 0);
            lastUpdateTime = packageInfo.lastUpdateTime;
        } catch (PackageManager.NameNotFoundException e) {
            e.printStackTrace();
        }
        return (lastUpdateTime != previousLastUpdateTime);
    }

    private void saveLastUpdateTime() {
        long lastUpdateTime = 1;
        try {
            PackageInfo packageInfo = getApplicationContext().getPackageManager().getPackageInfo(getApplicationContext().getPackageName(), 0);
            lastUpdateTime = packageInfo.lastUpdateTime;
        } catch (PackageManager.NameNotFoundException e) {
            e.printStackTrace();
        }
        SharedPreferences prefs = getApplicationContext().getSharedPreferences("NODEJS_MOBILE_PREFS", Context.MODE_PRIVATE);
        SharedPreferences.Editor editor = prefs.edit();
        editor.putLong("NODEJS_MOBILE_APK_LastUpdateTime", lastUpdateTime);
        editor.commit();
    }

    private static boolean deleteFolderRecursively(File file) {
        try {
            boolean res = true;
            for (File childFile : file.listFiles()) {
                if (childFile.isDirectory()) {
                    res &= deleteFolderRecursively(childFile);
                } else {
                    res &= childFile.delete();
                }
            }
            res &= file.delete();
            return res;
        } catch (Exception e) {
            e.printStackTrace();
            return false;
        }
    }

    private static boolean copyAssetFolder(AssetManager assetManager, String fromAssetPath, String toPath) {
        try {
            String[] files = assetManager.list(fromAssetPath);
            boolean res = true;

            if (files.length == 0) {
                res &= copyAsset(assetManager, fromAssetPath, toPath);
            } else {
                new File(toPath).mkdirs();
                for (String file : files)
                    res &= copyAssetFolder(assetManager, fromAssetPath + "/" + file, toPath + "/" + file);
            }
            return res;
        } catch (Exception e) {
            e.printStackTrace();
            return false;
        }
    }

    private static boolean copyAsset(AssetManager assetManager, String fromAssetPath, String toPath) {
        InputStream in = null;
        OutputStream out = null;
        try {
            in = assetManager.open(fromAssetPath);
            new File(toPath).createNewFile();
            out = new FileOutputStream(toPath);
            copyFile(in, out);
            in.close();
            in = null;
            out.flush();
            out.close();
            out = null;
            return true;
        } catch (Exception e) {
            e.printStackTrace();
            return false;
        }
    }

    private static void copyFile(InputStream in, OutputStream out) throws IOException {
        byte[] buffer = new byte[1024];
        int read;
        while ((read = in.read(buffer)) != -1) {
            out.write(buffer, 0, read);
        }
    }
}
