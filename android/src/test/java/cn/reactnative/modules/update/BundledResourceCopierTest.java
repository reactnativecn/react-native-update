package cn.reactnative.modules.update;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import org.junit.Test;

public class BundledResourceCopierTest {
    private static final HashSet<String> XXHDPI =
        new HashSet<String>(Collections.singleton("xxhdpi"));

    private static boolean canSubstitute(HashSet<String> installed, String... to) {
        return BundledResourceCopier.canSubstituteDensityVariant(to, installed);
    }

    @Test
    public void readsDensitiesFromConfigSplitNames() {
        HashSet<String> densities = BundledResourceCopier.installedSplitDensities(
            new ArrayList<String>(Arrays.asList(
                "/data/app/x/base.apk",
                "/data/app/x/split_config.arm64_v8a.apk",
                "/data/app/x/split_config.zh.apk",
                "/data/app/x/split_config.xxhdpi.apk",
                "/data/app/x/split_feature.config.tvdpi.apk"
            ))
        );
        assertEquals(new HashSet<String>(Arrays.asList("xxhdpi", "tvdpi")), densities);
    }

    @Test
    public void plainApkHasNoDensitySplits() {
        assertTrue(BundledResourceCopier.installedSplitDensities(
            new ArrayList<String>(Collections.singletonList("/data/app/x/base.apk"))
        ).isEmpty());
    }

    @Test
    public void otherDensityOfASplitInstallCanBeSubstituted() {
        assertTrue(canSubstitute(XXHDPI, "drawable-mdpi/a.png"));
        assertTrue(canSubstitute(XXHDPI, "drawable-xhdpi/a.png", "drawable-hdpi/b.png"));
    }

    @Test
    public void withoutADensitySplitEveryDensityShouldBeInstalled() {
        assertFalse(canSubstitute(new HashSet<String>(), "drawable-mdpi/a.png"));
    }

    @Test
    public void targetAtInstalledDensityIsDrift() {
        assertFalse(canSubstitute(XXHDPI, "drawable-xxhdpi/a.png"));
        assertFalse(canSubstitute(XXHDPI, "drawable-mdpi/a.png", "drawable-xxhdpi/b.png"));
    }

    @Test
    public void targetsWithoutADensityAreDrift() {
        assertFalse(canSubstitute(XXHDPI, "assets/a.png"));
        assertFalse(canSubstitute(XXHDPI, "raw/a.bin"));
        assertFalse(canSubstitute(XXHDPI, "drawable-nodpi/a.png"));
        assertFalse(canSubstitute(XXHDPI, "drawable/a.png"));
    }
}
