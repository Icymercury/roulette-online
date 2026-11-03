package com.shengsizhuanpan.app;

import android.app.Activity;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.KeyEvent;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 生死转盘 · 手机版壳。
 *
 * 设计要点：
 *  · 页面来自 App 内置的 assets/www/ —— 开局界面秒出，不依赖服务器在线；
 *    真正的对局仍然走 WebSocket 到电脑上那台 server.js。
 *  · 允许明文流量（usesCleartextTraffic）—— 局域网就是 http/ws，没它连不上。
 *  · RRNative 桥：
 *      ① 座位凭证写进 SharedPreferences（file:// 页面的 localStorage 不可靠）；
 *      ② **局域网服务器扫描** —— 浏览器里的 JS 发不了 UDP 广播（安全沙箱），
 *         所以扫描只能在原生层做，扫完把 JSON 塞回页面 window.RR.onServers()。
 *  · 返回键：能后退就后退，否则交给系统（退出 App）。
 *
 * 【构建约束 · 别改回去】
 *   本机打 APK 用的 d8（build-tools 34 自带）在读到「匿名内部类」时必崩：
 *       NullPointerException: Cannot invoke "String.length()" because "<parameter1>" is null
 *   实测：顶层类 OK，匿名内部类 FAIL。
 *   所以这个文件里**一个嵌套类、匿名类、lambda 都不许有** ——
 *   所有回调类都写成同文件的顶层 package-private 类，依赖用构造器传进去。
 */
public class MainActivity extends Activity {

    private static final String TAG = "Roulette";
    private WebView web;
    private SharedPreferences prefs;
    private NativeBridge bridge;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        prefs = getSharedPreferences("rr", MODE_PRIVATE);

        // 玩的时候别让屏幕自己灭
        getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0a0a0e"));
        web.setOverScrollMode(WebView.OVER_SCROLL_NEVER);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        try { s.setAllowFileAccessFromFileURLs(true); } catch (Throwable ignored) { }
        try { s.setAllowUniversalAccessFromFileURLs(true); } catch (Throwable ignored) { }
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        // 音频要在用户点过之后才响，不禁用自动播放
        if (Build.VERSION.SDK_INT >= 17) {
            s.setMediaPlaybackRequiresUserGesture(false);
        }
        if (Build.VERSION.SDK_INT >= 21) {
            // ws://192.168.x.x 属于明文，别被混合内容策略拦掉
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }

        web.setWebViewClient(new RWebClient());
        web.setWebChromeClient(new RChromeClient());

        // 页面里的 window.RRNative.*
        bridge = new NativeBridge(prefs, web);
        web.addJavascriptInterface(bridge, "RRNative");

        FrameLayout root = new FrameLayout(this);
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        // V16：首页是启动页（选单人 / 联机），游戏页从它跳过去
        web.loadUrl("file:///android_asset/www/start.html");
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && web != null && web.canGoBack()) {
            web.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onDestroy() {
        if (bridge != null) {
            bridge.stopDiscover();
            bridge = null;
        }
        if (web != null) {
            web.removeJavascriptInterface("RRNative");
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}

/** 站内跳转（client.html ↔ roulette-wheel.html）照常放行 */
class RWebClient extends WebViewClient {
    @Override
    public boolean shouldOverrideUrlLoading(WebView view, String url) {
        return false;
    }
}

/** 把网页 console 转到 logcat，排障用：adb logcat -s Roulette */
class RChromeClient extends WebChromeClient {
    @Override
    public boolean onConsoleMessage(ConsoleMessage m) {
        Log.d("Roulette", m.message() + " @" + m.sourceId() + ":" + m.lineNumber());
        return true;
    }
}

/**
 * 暴露给页面的桥，名字必须是 "RRNative"。
 * get/set/remove 存座位凭证与服务器地址；startDiscover/stopDiscover 扫局域网。
 */
class NativeBridge {

    private final SharedPreferences prefs;
    private final WebView web;
    private Discovery disc;

    NativeBridge(SharedPreferences p, WebView w) {
        this.prefs = p;
        this.web = w;
    }

    // ---------- ① 落盘（座位凭证 / 上次地址） ----------

    @JavascriptInterface
    public String get(String key) {
        try {
            return prefs.getString(key, "");
        } catch (Throwable e) {
            return "";
        }
    }

    @JavascriptInterface
    public void set(String key, String value) {
        try {
            prefs.edit().putString(key, value == null ? "" : value).apply();
        } catch (Throwable ignored) { }
    }

    @JavascriptInterface
    public void remove(String key) {
        try {
            prefs.edit().remove(key).apply();
        } catch (Throwable ignored) { }
    }

    // ---------- ② 局域网扫描 ----------

    @JavascriptInterface
    public void startDiscover() {
        try {
            if (disc == null) {
                disc = new Discovery(web);
            }
            disc.start();
        } catch (Throwable e) {
            Log.d("Roulette", "startDiscover failed: " + e);
        }
    }

    @JavascriptInterface
    public void stopDiscover() {
        try {
            if (disc != null) {
                disc.stop();
            }
        } catch (Throwable ignored) { }
    }
}

/**
 * 局域网服务器扫描器。
 *
 * **两条互相兜底的路**（和 PC 客户端 pc-client.js 的逻辑一模一样）：
 *   ① 主动：每 2.5 秒向广播地址发一条 {"RRSP":1,"q":"who"}，收 1.2 秒单播回复
 *   ② 被动：服务端每 3 秒自己往 255.255.255.255:8099 广播一次心跳，我们收着
 *
 * 为什么两条都要 —— 防火墙：
 *   ① 要求**电脑那边**放行入站 UDP 广播，否则它收不到手机的询问，一声不吭；
 *   ② 要求**手机这边**能收到入站广播（安卓默认允许）。
 *   电脑上第一次双击服务端时 Windows 会弹「允许访问？」，用户点了「取消」，
 *   ① 整条就废了 —— 这时候只有 ② 能救。两条路的要求正好互补，所以都留着。
 *
 * 卡片先进共享表（TTL 9 秒），两条路都往里塞，再由任一方把整张表推回页面。
 * 这样不会出现「后到的那条把先到的那条挤掉」。
 *
 * 为什么要在原生层做：**浏览器 / WebView 里的 JS 发不了 UDP 广播**。
 */
class Discovery {

    static final int PORT = 8099;
    static final int CARD_TTL_MS = 9000;
    static final String TAG = "Roulette";

    private final WebView web;

    /** key(id|host) → 卡片 JSON 原文；两条路共用 */
    private final Map<String, String> cards = new LinkedHashMap<String, String>();
    private final Map<String, Long> stamps = new LinkedHashMap<String, Long>();

    private volatile boolean running = false;
    private Thread worker;
    private Thread beat;
    private volatile DatagramSocket beatSock = null;

    Discovery(WebView w) {
        this.web = w;
    }

    void start() {
        if (running) {
            return;
        }
        running = true;
        worker = new Thread(new DiscoverLoop(this), "rr-discover");
        worker.setDaemon(true);
        worker.start();
        beat = new Thread(new Heartbeat(this), "rr-heartbeat");
        beat.setDaemon(true);
        beat.start();
    }

    void stop() {
        running = false;
        worker = null;
        beat = null;
        DatagramSocket s = beatSock;
        if (s != null) {
            try { s.close(); } catch (Throwable ignored) { }   // 关掉才能立刻解开 receive()
        }
    }

    boolean isRunning() {
        return running;
    }

    void keepBeatSock(DatagramSocket s) {
        beatSock = s;
    }

    /** 收到一张卡片（两条路都调它）。key 用「编号|地址|端口」，同一台机器开多个服务端也能分开。 */
    void addCard(JSONObject o, String host) {
        try {
            o.put("host", host);
            String key = o.optString("id", "?") + "|" + host + "|" + o.optInt("port", 0);
            synchronized (this) {
                cards.put(key, o.toString());
                stamps.put(key, Long.valueOf(System.currentTimeMillis()));
            }
        } catch (Throwable e) {
            Log.d(TAG, "addCard failed: " + e);
        }
    }

    /** 把还活着的卡片拼成一个 JSON 数组 */
    private String snapshotJson() {
        JSONArray arr = new JSONArray();
        synchronized (this) {
            long now = System.currentTimeMillis();
            Iterator<String> it = cards.keySet().iterator();
            while (it.hasNext()) {
                String k = it.next();
                Long ts = stamps.get(k);
                if (ts == null || now - ts.longValue() > CARD_TTL_MS) {
                    it.remove();
                    stamps.remove(k);
                    continue;
                }
                try {
                    arr.put(new JSONObject(cards.get(k)));
                } catch (Throwable ignored) { }
            }
        }
        return arr.toString();
    }

    /** 把当前整张表推回页面（两条路谁收到东西谁调） */
    void deliverSnapshot() {
        if (!running) {
            return;
        }
        deliver(snapshotJson());
    }

    /**
     * 广播目标：除了 255.255.255.255，还按每块网卡算出 /24 的广播地址。
     * 有些手机的 Wi-Fi 驱动会把「有限广播」丢掉，多打几枪才稳。
     */
    private List<String> targets() {
        List<String> all = new ArrayList<String>();
        all.add("255.255.255.255");
        try {
            Enumeration<java.net.NetworkInterface> nifs = java.net.NetworkInterface.getNetworkInterfaces();
            while (nifs.hasMoreElements()) {
                java.net.NetworkInterface nif = nifs.nextElement();
                if (!nif.isUp() || nif.isLoopback()) {
                    continue;
                }
                Enumeration<InetAddress> as = nif.getInetAddresses();
                while (as.hasMoreElements()) {
                    InetAddress a = as.nextElement();
                    byte[] b = a.getAddress();
                    if (b == null || b.length != 4 || a.isLoopbackAddress()) {
                        continue;
                    }
                    all.add((b[0] & 0xFF) + "." + (b[1] & 0xFF) + "." + (b[2] & 0xFF) + ".255");
                }
            }
        } catch (Throwable ignored) { }
        List<String> uniq = new ArrayList<String>();
        for (int i = 0; i < all.size(); i++) {
            if (!uniq.contains(all.get(i))) {
                uniq.add(all.get(i));
            }
        }
        return uniq;
    }

    /** 扫一轮并回报一次 */
    void round() {
        DatagramSocket sock = null;
        try {
            sock = new DatagramSocket();
            sock.setBroadcast(true);
            sock.setSoTimeout(400);

            byte[] q = "{\"RRSP\":1,\"q\":\"who\"}".getBytes("UTF-8");
            List<String> tg = targets();
            for (int i = 0; i < tg.size(); i++) {
                try {
                    DatagramPacket out = new DatagramPacket(
                            q, q.length, InetAddress.getByName(tg.get(i)), PORT);
                    sock.send(out);
                } catch (Throwable ignored) { }
            }

            long until = System.currentTimeMillis() + 1200;
            byte[] buf = new byte[2048];
            while (System.currentTimeMillis() < until) {
                DatagramPacket in = new DatagramPacket(buf, buf.length);
                try {
                    sock.receive(in);
                } catch (java.net.SocketTimeoutException te) {
                    continue;
                }
                String body = new String(in.getData(), 0, in.getLength(), "UTF-8");
                JSONObject o = new JSONObject(body);
                if (o.optInt("RRSP", 0) != 1) {
                    continue;                      // 不是我们的包
                }
                if (o.has("q")) {
                    continue;                      // 别的客户端在问，不是服务器卡片
                }
                // 地址不在卡片里 —— 它是「谁回的包」这个事实
                addCard(o, in.getAddress().getHostAddress());
            }

            deliverSnapshot();
        } catch (Throwable e) {
            Log.d(TAG, "discover round failed: " + e);
        } finally {
            if (sock != null) {
                try { sock.close(); } catch (Throwable ignored) { }
            }
        }
    }

    /** 回 UI 线程再执行 JS（Runnable 必须是顶层类，不能写匿名内部类） */
    private void deliver(String json) {
        String code = "window.RR && window.RR.onServers(" + JSONObject.quote(json) + ")";
        try {
            web.post(new JsRunner(web, code));
        } catch (Throwable e) {
            Log.d(TAG, "deliver failed: " + e);
        }
    }
}

/** 扫描循环（顶层类，避免匿名内部类） */
class DiscoverLoop implements Runnable {

    private final Discovery owner;

    DiscoverLoop(Discovery d) {
        this.owner = d;
    }

    @Override
    public void run() {
        while (owner.isRunning()) {
            owner.round();
            if (!owner.isRunning()) {
                return;
            }
            try {
                Thread.sleep(2500);
            } catch (InterruptedException e) {
                return;
            }
        }
    }
}

/**
 * 被动收听服务端的心跳（第二条路，顶层类，避免匿名内部类）。
 *
 * 服务端每 3 秒往 255.255.255.255:8099 广播一次卡片。这里把 8099 端口用
 * SO_REUSEADDR 长期占着收 —— 它和上面主动询问那条路用的是**不同**的 socket，
 * 互不干扰。绑不上（端口被占）就直接放弃，不影响主动询问。
 */
class Heartbeat implements Runnable {

    private final Discovery owner;

    Heartbeat(Discovery d) {
        this.owner = d;
    }

    @Override
    public void run() {
        DatagramSocket sock = null;
        try {
            sock = new DatagramSocket(null);
            sock.setReuseAddress(true);
            sock.bind(new InetSocketAddress(Discovery.PORT));
            sock.setBroadcast(true);
            sock.setSoTimeout(1000);
            owner.keepBeatSock(sock);
            Log.d(Discovery.TAG, "heartbeat listening on " + Discovery.PORT);

            byte[] buf = new byte[2048];
            while (owner.isRunning()) {
                DatagramPacket in = new DatagramPacket(buf, buf.length);
                try {
                    sock.receive(in);
                } catch (java.net.SocketTimeoutException te) {
                    continue;
                } catch (Throwable e) {
                    return;                      // socket 被 stop() 关了，收工
                }
                String body = new String(in.getData(), 0, in.getLength(), "UTF-8");
                JSONObject o = new JSONObject(body);
                if (o.optInt("RRSP", 0) != 1) {
                    continue;
                }
                if (o.has("q")) {
                    continue;                    // 自己的 / 别人的询问包，不是卡片
                }
                owner.addCard(o, in.getAddress().getHostAddress());
                owner.deliverSnapshot();
            }
        } catch (Throwable e) {
            Log.d(Discovery.TAG, "heartbeat unavailable: " + e);
        } finally {
            if (sock != null) {
                try { sock.close(); } catch (Throwable ignored) { }
            }
        }
    }
}

/** 在 UI 线程上执行一段 JS（顶层类，避免匿名内部类） */
class JsRunner implements Runnable {

    private final WebView web;
    private final String code;

    JsRunner(WebView w, String c) {
        this.web = w;
        this.code = c;
    }

    @Override
    public void run() {
        try {
            web.evaluateJavascript(code, null);
        } catch (Throwable ignored) { }
    }
}
