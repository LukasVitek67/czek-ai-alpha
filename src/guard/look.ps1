# czek-guard: snímek okna appky pro nástroj look (src/guard/look.mjs). Najde viditelné okno podle názvu procesu
# (FurryBee / FurryBee.exe) nebo části titulku, vezme největší, zachytí ho přes PrintWindow (PW_RENDERFULLCONTENT –
# i okno za jinými okny) a když vyjde skoro jednobarevný snímek (GPU okno, které PrintWindow nevykreslí), vezme výřez
# obrazovky v místě okna (okno dá do popředí). Výstup: jeden řádek JSON.
param([string]$Target = '', [string]$Out = '', [int]$ProcId = 0)
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System; using System.Drawing; using System.Drawing.Imaging; using System.Runtime.InteropServices;
using System.Text; using System.Diagnostics; using System.Collections.Generic;
public static class CzekLook {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
  static string J(string s) {
    var b = new StringBuilder("\"");
    foreach (char c in s ?? "") { if (c == '"' || c == '\\') b.Append('\\').Append(c); else if (c < 32) b.Append(' '); else b.Append(c); }
    return b.Append('"').ToString();
  }
  static bool Blank(Bitmap b) {
    Color c0 = b.GetPixel(b.Width / 2, b.Height / 2); int same = 0, n = 0;
    int sx = Math.Max(1, b.Width / 24), sy = Math.Max(1, b.Height / 24);
    for (int y = 0; y < b.Height; y += sy) for (int x = 0; x < b.Width; x += sx) {
      n++; Color c = b.GetPixel(x, y);
      if (Math.Abs(c.R - c0.R) + Math.Abs(c.G - c0.G) + Math.Abs(c.B - c0.B) < 12) same++;
    }
    return same > n * 0.97;
  }
  // PrintWindow okna bez podpory DPI vykreslí obsah v logické velikosti do většího (fyzického) rámečku → zbytek zůstane
  // průhledný. Oříznout na vykreslenou oblast (poslední sloupec / řádek s neprůhledným pixelem).
  static Bitmap CropAlpha(Bitmap b) {
    var d = b.LockBits(new Rectangle(0, 0, b.Width, b.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    var px = new byte[d.Stride * b.Height]; Marshal.Copy(d.Scan0, px, 0, px.Length); int stride = d.Stride; b.UnlockBits(d);
    int maxX = 0, maxY = 0;
    for (int y = 0; y < b.Height; y += 2) for (int x = 0; x < b.Width; x += 2) if (px[y * stride + x * 4 + 3] > 0) { if (x > maxX) maxX = x; if (y > maxY) maxY = y; }
    int w = Math.Min(b.Width, maxX + 2), h = Math.Min(b.Height, maxY + 2);
    if (w < 16 || h < 16 || (w >= b.Width - 2 && h >= b.Height - 2)) return b;
    return b.Clone(new Rectangle(0, 0, w, h), PixelFormat.Format32bppArgb);
  }
  public static string Capture(string target, int pid, string outFile) {
    try { SetProcessDPIAware(); } catch { }
    string t = (target ?? "").Trim().ToLowerInvariant(); if (t.EndsWith(".exe")) t = t.Substring(0, t.Length - 4);
    IntPtr best = IntPtr.Zero; long bestArea = 0; string bestTitle = "", bestProc = ""; uint bestPid = 0;
    var names = new Dictionary<uint, string>(); var seen = new List<string>();
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512); GetWindowText(h, sb, 512); string title = sb.ToString();
      if (title.Length == 0) return true;
      uint p; GetWindowThreadProcessId(h, out p);
      string pn; if (!names.TryGetValue(p, out pn)) { try { pn = Process.GetProcessById((int)p).ProcessName; } catch { pn = ""; } names[p] = pn; }
      RECT r; GetWindowRect(h, out r); long a = (long)(r.R - r.L) * (r.B - r.T);
      // pro model jen názvy procesů, ne titulky (titulky cizích oken – prohlížeč, chat – nemají jít k poskytovateli)
      if (a > 2500 && pn.Length > 0 && !seen.Contains(pn) && seen.Count < 25) seen.Add(pn);
      bool m = (pid > 0 && p == pid) || (t.Length > 0 && (pn.ToLowerInvariant() == t || title.ToLowerInvariant().Contains(t)));
      if (m && a > bestArea) { bestArea = a; best = h; bestTitle = title; bestProc = pn; bestPid = p; }
      return true;
    }, IntPtr.Zero);
    if (best == IntPtr.Zero) return "{\"error\":\"not found\",\"windows\":[" + string.Join(",", seen.ConvertAll(J)) + "]}";
    if (IsIconic(best)) { ShowWindow(best, 9); System.Threading.Thread.Sleep(500); }
    RECT rc; GetWindowRect(best, out rc); int w = rc.R - rc.L, hh = rc.B - rc.T;
    if (w <= 0 || hh <= 0) return "{\"error\":\"empty window\"}";
    string method = "PrintWindow";
    var bmp = new Bitmap(w, hh, PixelFormat.Format32bppArgb);
    using (var g = Graphics.FromImage(bmp)) { IntPtr dc = g.GetHdc(); PrintWindow(best, dc, 2); g.ReleaseHdc(dc); }
    bmp = CropAlpha(bmp);
    if (Blank(bmp)) {
      bmp = new Bitmap(w, hh, PixelFormat.Format32bppArgb);
      SetForegroundWindow(best); System.Threading.Thread.Sleep(500);
      GetWindowRect(best, out rc);
      using (var g = Graphics.FromImage(bmp)) g.CopyFromScreen(rc.L, rc.T, 0, 0, new Size(w, hh));
      method = Blank(bmp) ? "CopyFromScreen (still blank)" : "CopyFromScreen";
    }
    bmp.Save(outFile, ImageFormat.Png);
    return "{\"file\":" + J(outFile) + ",\"title\":" + J(bestTitle) + ",\"process\":" + J(bestProc) + ",\"pid\":" + bestPid + ",\"width\":" + bmp.Width + ",\"height\":" + bmp.Height + ",\"method\":" + J(method) + "}";
  }
}
'@
try { [Console]::Out.WriteLine([CzekLook]::Capture($Target, $ProcId, $Out)) }
catch { [Console]::Out.WriteLine('{"error":' + (ConvertTo-Json ([string]$_.Exception.Message)) + '}') }
