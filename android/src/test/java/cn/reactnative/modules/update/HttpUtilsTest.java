package cn.reactnative.modules.update;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class HttpUtilsTest {
    @Test
    public void parseContentRangeReturnsTotal() {
        assertEquals(200, HttpUtils.parseContentRange("bytes 100-199/200", 100));
        assertEquals(10, HttpUtils.parseContentRange("bytes 0-9/10", 0));
        assertEquals(10, HttpUtils.parseContentRange("bytes  5-9 / 10 ", 5));
    }

    @Test
    public void parseContentRangeUnknownTotalIsZero() {
        assertEquals(0, HttpUtils.parseContentRange("bytes 100-199/*", 100));
    }

    @Test
    public void parseContentRangeRejectsMismatchedStart() {
        assertEquals(-1, HttpUtils.parseContentRange("bytes 0-199/200", 100));
        assertEquals(-1, HttpUtils.parseContentRange("bytes 101-199/200", 100));
    }

    @Test
    public void parseContentRangeRejectsMalformedHeaders() {
        assertEquals(-1, HttpUtils.parseContentRange(null, 0));
        assertEquals(-1, HttpUtils.parseContentRange("", 0));
        assertEquals(-1, HttpUtils.parseContentRange("bytes", 0));
        assertEquals(-1, HttpUtils.parseContentRange("bytes */200", 0));
        assertEquals(-1, HttpUtils.parseContentRange("bytes x-y/z", 0));
        assertEquals(-1, HttpUtils.parseContentRange("bytes 0-9", 0));
        assertEquals(-1, HttpUtils.parseContentRange("bytes 10/20-30", 10));
        assertEquals(-1, HttpUtils.parseContentRange("bytes 0-9/abc", 0));
        assertEquals(-1, HttpUtils.parseContentRange("items 0-9/10", 0));
    }

    @Test
    public void normalizeEndpointBaseStripsTrailingSlashes() {
        assertEquals("https://update.example.com", HttpUtils.normalizeEndpointBase("https://update.example.com/"));
        assertEquals("https://update.example.com", HttpUtils.normalizeEndpointBase("https://update.example.com///"));
        assertEquals("https://update.example.com/api", HttpUtils.normalizeEndpointBase("https://update.example.com/api"));
        assertEquals("", HttpUtils.normalizeEndpointBase(""));
        assertEquals("", HttpUtils.normalizeEndpointBase("/"));
    }

    @Test
    public void isHttpsUrlIsCaseInsensitiveAndStrict() {
        assertTrue(HttpUtils.isHttpsUrl("https://example.com/app.apk"));
        assertTrue(HttpUtils.isHttpsUrl("HTTPS://example.com/app.apk"));
        assertFalse(HttpUtils.isHttpsUrl("http://example.com/app.apk"));
        assertFalse(HttpUtils.isHttpsUrl("https:/example.com"));
        assertFalse(HttpUtils.isHttpsUrl("ftp://example.com"));
        assertFalse(HttpUtils.isHttpsUrl(""));
        assertFalse(HttpUtils.isHttpsUrl(null));
    }
}
