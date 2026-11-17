package com.metrodesigner.android;

import org.junit.Test;
import static org.junit.Assert.*;

public class ClientPolicyTest {
    @Test public void officialSiteBoundary() {
        assertTrue(ClientPolicy.isSite("https://www.metro-designer.com/?a=1"));
        assertTrue(ClientPolicy.isSite("https://metro-designer.com:443/"));
        for (String bad : new String[]{"http://www.metro-designer.com/", "https://www.metro-designer.com.evil.test/",
            "https://www.metro-designer.com@evil.test/", "file:///private/", "javascript:alert(1)",
            "https://www.metro-designer.com:444/", "https://user@metro-designer.com/"}) assertFalse(bad, ClientPolicy.isSite(bad));
    }
    @Test public void externalProtocols() {
        assertTrue(ClientPolicy.isExternal("https://github.com/zhaohe-ming/metro-designer"));
        assertTrue(ClientPolicy.isExternal("mailto:test@example.invalid"));
        assertFalse(ClientPolicy.isExternal("intent://anything"));
        assertFalse(ClientPolicy.isExternal("file:///sdcard/test"));
    }
    @Test public void exportNamesStayDocuments() {
        assertEquals("_地图.png", ClientPolicy.filename("../地图", "image/png"));
        assertEquals("design.apk.png", ClientPolicy.filename("design.apk", "image/png"));
        assertTrue(ClientPolicy.filename("a".repeat(200), "video/webm").length() <= 120);
        assertThrows(IllegalArgumentException.class, () -> ClientPolicy.extension("application/vnd.android.package-archive"));
    }
    @Test public void streamingBounds() {
        ClientPolicy.validateProgress(100, 50, 50);
        assertThrows(IllegalArgumentException.class, () -> ClientPolicy.validateProgress(100, 50, 51));
        assertThrows(IllegalArgumentException.class, () -> ClientPolicy.validateProgress(100000, 0, 65537));
        assertThrows(IllegalArgumentException.class, () -> ClientPolicy.validateProgress(0, 0, 1));
    }
}
