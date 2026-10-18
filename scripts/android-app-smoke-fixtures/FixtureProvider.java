package ai.anymize.smokefixture;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.FileNotFoundException;

/** Read-only, non-exported provider. No network, foreign paths or production data. */
public final class FixtureProvider extends ContentProvider {
  @Override public boolean onCreate() {
    try {
      File target = new File(getContext().getFilesDir(), "original.pdf");
      try (InputStream input = getContext().getAssets().open("fixture.pdf"); FileOutputStream output = new FileOutputStream(target)) {
        byte[] block = new byte[8192]; int count;
        while ((count = input.read(block)) > 0) output.write(block, 0, count);
      }
      return true;
    } catch (Exception error) { throw new IllegalStateException("Synthetic fixture setup failed", error); }
  }
  private File file(Uri uri) throws FileNotFoundException {
    if (!"content".equals(uri.getScheme()) || !"ai.anymize.smokefixture.pdf".equals(uri.getAuthority()) || uri.getQuery() != null || uri.getFragment() != null) throw new FileNotFoundException("Unknown synthetic fixture");
    String path = uri.getPath();
    if (!"/original".equals(path) && !"/saved".equals(path)) throw new FileNotFoundException("Unknown synthetic fixture");
    File file = new File(getContext().getFilesDir(), "/saved".equals(path) ? "saved.pdf" : "original.pdf");
    if (!file.isFile() || file.length() < 8 || file.length() > 2 * 1024 * 1024) throw new FileNotFoundException("Unavailable synthetic PDF");
    return file;
  }
  @Override public String getType(Uri uri) { return "application/pdf"; }
  @Override public Cursor query(Uri uri, String[] projection, String selection, String[] args, String sort) {
    try {
      File file = file(uri);
      String[] columns = projection == null ? new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE} : projection;
      MatrixCursor result = new MatrixCursor(columns); Object[] values = new Object[columns.length];
      for (int index = 0; index < columns.length; index++) {
        if (OpenableColumns.DISPLAY_NAME.equals(columns[index])) values[index] = "/saved".equals(uri.getPath()) ? "anymize-smoke-saved.pdf" : "anymize-smoke-fixture.pdf";
        else if (OpenableColumns.SIZE.equals(columns[index])) values[index] = file.length();
      }
      result.addRow(values); return result;
    } catch (FileNotFoundException error) { throw new IllegalArgumentException(error); }
  }
  @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
    if (!"r".equals(mode)) throw new FileNotFoundException("Synthetic provider is read-only");
    return ParcelFileDescriptor.open(file(uri), ParcelFileDescriptor.MODE_READ_ONLY);
  }
  @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }
  @Override public int update(Uri uri, ContentValues values, String selection, String[] args) { throw new UnsupportedOperationException(); }
  @Override public int delete(Uri uri, String selection, String[] args) { throw new UnsupportedOperationException(); }
}
