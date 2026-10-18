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
    String selected = "saved".equals(getIntent().getStringExtra("fixture")) ? "saved" : "original";
    Uri uri = Uri.parse("content://ai.anymize.smokefixture.pdf/" + selected);
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
