package cn.reactnative.modules.update;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertNull;
import org.junit.Test;

public class CleanupKeepNamesTest {
    @Test
    public void fillsAvailableSlotsAndDeduplicates() {
        assertArrayEquals(new String[] {"current", "running"},
            CleanupKeepNames.select("current", null, "running"));
        assertArrayEquals(new String[] {"same", "running"},
            CleanupKeepNames.select("same", "same", "running"));
        assertArrayEquals(new String[] {"running", null},
            CleanupKeepNames.select(null, null, "running"));
    }

    @Test
    public void defersWhenThreeDistinctVersionsNeedProtection() {
        assertNull(CleanupKeepNames.select("current", "previous", "running"));
    }
}
