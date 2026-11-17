package com.metrodesigner.android;

import java.net.URI;
import java.util.Locale;

public final class ClientPolicy {
    private ClientPolicy() {}
    public static boolean isSite(String url) {
        try {
            URI u = new URI(url);
            return "https".equalsIgnoreCase(u.getScheme()) && u.getUserInfo() == null
                && (u.getPort() == -1 || u.getPort() == 443)
                && ("www.metro-designer.com".equalsIgnoreCase(u.getHost())
                    || "metro-designer.com".equalsIgnoreCase(u.getHost()));
        } catch (Exception e) { return false; }
    }
    public static boolean isExternal(String url) {
        try {
            URI u = new URI(url);
            return ("https".equalsIgnoreCase(u.getScheme()) && u.getHost() != null && u.getUserInfo() == null)
                || "mailto".equalsIgnoreCase(u.getScheme());
        } catch (Exception e) { return false; }
    }
    public static String extension(String mime) {
        switch (mime.toLowerCase(Locale.ROOT)) {
            case "image/png": return ".png";
            case "image/jpeg": return ".jpg";
            case "video/webm": return ".webm";
            case "video/mp4": return ".mp4";
            case "application/json": return ".json";
            default: throw new IllegalArgumentException("Unsupported export type");
        }
    }
    public static String filename(String input, String mime) {
        String ext = extension(mime);
        String name = input.replaceAll("[\\p{Cntrl}<>:\"/\\\\|?*]", "_").trim();
        while (name.startsWith(".")) name = name.substring(1);
        if (name.isEmpty()) name = "metro-export";
        if (!name.toLowerCase(Locale.ROOT).endsWith(ext)) name += ext;
        if (name.length() > 120) name = name.substring(0, 120 - ext.length()) + ext;
        return name;
    }
    public static void validateProgress(long expected, long received, int chunkSize) {
        if (expected < 1 || expected > 512L * 1024 * 1024 || chunkSize < 1 || chunkSize > 65536
            || received < 0 || received + chunkSize > expected)
            throw new IllegalArgumentException("Export size exceeds bounds");
    }
}
