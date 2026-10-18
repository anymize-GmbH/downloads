package ai.anymize.smokefixture;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

/** Grants only synthetic fixture bytes to the unchanged installed application. */
public final class GrantActivity extends Activity {
  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    String selected = getIntent().getStringExtra("fixture");
    if (!"saved".equals(selected) && !"second".equals(selected) && !"stall".equals(selected)) selected = "original";
    Uri uri = Uri.parse("content://ai.anymize.smokefixture.pdf/" + selected);
    if (getIntent().getBooleanExtra("audit", false)) {
      // Genuine positive control: only the helper opens its own fixture. This
      // path neither launches the suite nor changes its authentication state.
      try (android.os.ParcelFileDescriptor file = getContentResolver().openFileDescriptor(uri, "r")) {
        if (file == null) throw new IllegalStateException("Synthetic read returned no descriptor");
      } catch (Exception error) { throw new IllegalStateException("Synthetic positive control failed", error); }
      finish();
      return;
    }
    Intent view = new Intent(Intent.ACTION_VIEW);
    view.setDataAndType(uri, "application/pdf");
    view.setPackage("ai.anymize.mobile");
    view.setClipData(ClipData.newRawUri("Synthetic local PDF", uri));
    view.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    grantUriPermission("ai.anymize.mobile", uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
    startActivity(view);
    finish();
  }
}
