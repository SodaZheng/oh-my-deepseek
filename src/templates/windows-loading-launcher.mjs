export function renderWindowsLoadingLauncherSource({
  programPath,
  programArguments,
  appUserModelId,
  loadingName,
  loadingMessage,
  loadingIconPath,
  windowIconPath,
  windowBoundsPath,
  loadingBoundsPath,
  handoffReadyPath,
  activeWindowHandlePath,
  missingTitle,
  missingMessage,
}) {
  const encoded = (value) => Buffer.from(String(value), "utf8").toString("base64");
  const argumentValues = programArguments.map((value) => `Decode("${encoded(value)}")`).join(", ");
  return `using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

internal static class OhMyDeepSeekLoadingLauncher {
  private static readonly string ProgramPath = Decode("${encoded(programPath)}");
  private static readonly string[] ProgramArguments = new string[] { ${argumentValues} };
  private static readonly string AppUserModelId = Decode("${encoded(appUserModelId)}");
  private static readonly string LoadingName = Decode("${encoded(loadingName)}");
  private static readonly string LoadingMessage = Decode("${encoded(loadingMessage)}");
  private static readonly string LoadingIconPath = Decode("${encoded(loadingIconPath)}");
  private static readonly string WindowIconPath = Decode("${encoded(windowIconPath)}");
  private static readonly string WindowBoundsPath = Decode("${encoded(windowBoundsPath)}");
  private static readonly string LoadingBoundsPath = Decode("${encoded(loadingBoundsPath)}");
  private static readonly string HandoffReadyPath = Decode("${encoded(handoffReadyPath)}");
  private static readonly string ActiveWindowHandlePath = Decode("${encoded(activeWindowHandlePath)}");
  private static readonly string MissingTitle = Decode("${encoded(missingTitle)}");
  private static readonly string MissingMessage = Decode("${encoded(missingMessage)}");

  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  private static extern int SetCurrentProcessExplicitAppUserModelID(string appId);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int MessageBoxW(IntPtr window, string message, string title, uint type);

  [DllImport("user32.dll")]
  private static extern bool IsWindow(IntPtr window);

  [STAThread]
  private static int Main() {
    SetCurrentProcessExplicitAppUserModelID(AppUserModelId);
    if (!File.Exists(ProgramPath)) {
      MessageBoxW(IntPtr.Zero, MissingMessage, MissingTitle, 0x10);
      return 1;
    }
    if (!File.Exists(LoadingIconPath)) {
      MessageBoxW(IntPtr.Zero, "Loading image is missing: " + LoadingIconPath, MissingTitle, 0x10);
      return 1;
    }
    if (AppIsOpen()) return RunWithoutLoading();

    bool created;
    using (var mutex = new Mutex(true, "Local\\\\OhMyDeepSeek.LoadingLauncher." + AppUserModelId, out created)) {
      if (!created) return RunWithoutLoading();
      TryDelete(HandoffReadyPath);
      Process child = null;
      Exception startError = null;
      var exitCode = 0;
      Application.EnableVisualStyles();
      Application.SetCompatibleTextRenderingDefault(false);

      using (var form = new LoadingForm(
        LoadingName,
        LoadingMessage,
        LoadingIconPath,
        WindowIconPath,
        WindowBoundsPath,
        LoadingBoundsPath)) {
        using (var handoffTimer = new System.Windows.Forms.Timer()) {
          handoffTimer.Interval = 40;
          form.Shown += delegate {
            try {
              child = StartProgram();
            } catch (Exception error) {
              startError = error;
              form.CloseForProgramExit();
            }
          };
          handoffTimer.Tick += delegate {
            if (File.Exists(HandoffReadyPath)) {
              form.CloseForHandoff();
              return;
            }
            if (child != null) {
              try {
                child.Refresh();
                if (child.HasExited) form.CloseForProgramExit();
              } catch {
                form.CloseForProgramExit();
              }
            }
          };
          handoffTimer.Start();
          Application.Run(form);
          handoffTimer.Stop();
        }

        if (form.UserCancelled) {
          if (child != null) KillProcessTree(child);
          TryDelete(HandoffReadyPath);
          return 0;
        }
        if (startError != null) {
          MessageBoxW(IntPtr.Zero, startError.Message, MissingTitle, 0x10);
          return 1;
        }
        if (child == null) return 1;
        if (form.HandoffComplete) {
          child.Dispose();
          return 0;
        }
        try {
          child.WaitForExit();
          exitCode = child.ExitCode;
        } finally {
          child.Dispose();
        }
        if (!form.HandoffComplete && exitCode != 0) {
          MessageBoxW(IntPtr.Zero, "The launcher exited before the app was ready.", MissingTitle, 0x10);
        }
      }
      return exitCode;
    }
  }

  private static int RunWithoutLoading() {
    try {
      using (var process = StartProgram()) {
        process.WaitForExit();
        return process.ExitCode;
      }
    } catch (Exception error) {
      MessageBoxW(IntPtr.Zero, error.Message, MissingTitle, 0x10);
      return 1;
    }
  }

  private static bool AppIsOpen() {
    if (!File.Exists(HandoffReadyPath) || !File.Exists(ActiveWindowHandlePath)) return false;
    try {
      long handle;
      var contents = File.ReadAllText(ActiveWindowHandlePath, Encoding.ASCII).Trim();
      return long.TryParse(contents, out handle) && handle != 0 && IsWindow(new IntPtr(handle));
    } catch {
      return false;
    }
  }

  private static Process StartProgram() {
    var startInfo = new ProcessStartInfo {
      FileName = ProgramPath,
      Arguments = BuildCommandLine(ProgramArguments),
      WorkingDirectory = Path.GetDirectoryName(ProgramPath),
      UseShellExecute = false,
      CreateNoWindow = true,
      WindowStyle = ProcessWindowStyle.Hidden,
    };
    var process = Process.Start(startInfo);
    if (process == null) throw new InvalidOperationException("Failed to start the app supervisor.");
    return process;
  }

  private static void KillProcessTree(Process process) {
    try {
      process.Refresh();
      if (process.HasExited) return;
      var startInfo = new ProcessStartInfo {
        FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "taskkill.exe"),
        Arguments = "/PID " + process.Id + " /T /F",
        UseShellExecute = false,
        CreateNoWindow = true,
        WindowStyle = ProcessWindowStyle.Hidden,
      };
      using (var killer = Process.Start(startInfo)) {
        if (killer != null) killer.WaitForExit(5000);
      }
    } catch {}
  }

  private static void TryDelete(string filePath) {
    try { if (File.Exists(filePath)) File.Delete(filePath); } catch {}
  }

  private static string BuildCommandLine(string[] arguments) {
    var result = new StringBuilder();
    for (var index = 0; index < arguments.Length; index += 1) {
      if (index > 0) result.Append(' ');
      result.Append(QuoteArgument(arguments[index]));
    }
    return result.ToString();
  }

  private static string QuoteArgument(string value) {
    if (value.Length > 0 && value.IndexOfAny(new char[] { ' ', '\\t', '\\n', '\\v', '"' }) < 0) return value;
    var result = new StringBuilder();
    result.Append('"');
    var backslashes = 0;
    foreach (var character in value) {
      if (character == '\\\\') {
        backslashes += 1;
        continue;
      }
      if (character == '"') {
        result.Append('\\\\', backslashes * 2 + 1);
        result.Append('"');
      } else {
        result.Append('\\\\', backslashes);
        result.Append(character);
      }
      backslashes = 0;
    }
    result.Append('\\\\', backslashes * 2);
    result.Append('"');
    return result.ToString();
  }

  private static string Decode(string value) {
    return Encoding.UTF8.GetString(Convert.FromBase64String(value));
  }
}

internal sealed class LoadingForm : Form {
  private const int DwmUseImmersiveDarkMode = 20;
  private readonly string loadingBoundsPath;
  private bool internalClose;
  private Icon ownedIcon;

  [DllImport("dwmapi.dll")]
  private static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);

  internal bool HandoffComplete { get; private set; }
  internal bool UserCancelled { get; private set; }

  internal LoadingForm(
    string name,
    string message,
    string loadingIconPath,
    string windowIconPath,
    string windowBoundsPath,
    string loadingBoundsPathValue) {
    loadingBoundsPath = loadingBoundsPathValue;
    Text = name;
    BackColor = Color.FromArgb(21, 21, 23);
    ForeColor = Color.FromArgb(207, 211, 214);
    MinimumSize = new Size(640, 480);
    Size = ReadSavedSize(windowBoundsPath, new Size(1000, 720));
    StartPosition = FormStartPosition.Manual;
    var work = Screen.PrimaryScreen.WorkingArea;
    Size = new Size(Math.Min(Size.Width, work.Width), Math.Min(Size.Height, work.Height));
    Location = new Point(work.Left + (work.Width - Width) / 2, work.Top + (work.Height - Height) / 2);
    KeyPreview = true;
    TopMost = true;
    AccessibleName = message;
    try {
      ownedIcon = string.Equals(Path.GetExtension(windowIconPath), ".ico", StringComparison.OrdinalIgnoreCase)
        ? new Icon(windowIconPath)
        : Icon.ExtractAssociatedIcon(windowIconPath);
      if (ownedIcon != null) Icon = ownedIcon;
    } catch {}
    Controls.Add(new WhaleCanvas(message, loadingIconPath) { Dock = DockStyle.Fill });
    Shown += delegate { SaveBounds(); };
    Move += delegate { SaveBounds(); };
    ResizeEnd += delegate { SaveBounds(); };
  }

  protected override void OnHandleCreated(EventArgs eventArguments) {
    base.OnHandleCreated(eventArguments);
    var enabled = 1;
    if (DwmSetWindowAttribute(Handle, DwmUseImmersiveDarkMode, ref enabled, sizeof(int)) < 0) {
      var legacyAttribute = 19;
      DwmSetWindowAttribute(Handle, legacyAttribute, ref enabled, sizeof(int));
    }
  }

  protected override void OnFormClosing(FormClosingEventArgs eventArguments) {
    if (!internalClose && eventArguments.CloseReason == CloseReason.UserClosing) UserCancelled = true;
    base.OnFormClosing(eventArguments);
  }

  protected override void Dispose(bool disposing) {
    if (disposing && ownedIcon != null) ownedIcon.Dispose();
    base.Dispose(disposing);
  }

  internal void CloseForHandoff() {
    if (IsDisposed) return;
    HandoffComplete = true;
    internalClose = true;
    Close();
  }

  internal void CloseForProgramExit() {
    if (IsDisposed) return;
    internalClose = true;
    Close();
  }

  private void SaveBounds() {
    if (WindowState != FormWindowState.Normal || Width < 320 || Height < 240) return;
    try {
      var directory = Path.GetDirectoryName(loadingBoundsPath);
      if (!Directory.Exists(directory)) Directory.CreateDirectory(directory);
      var json = "{\\"x\\":" + Left + ",\\"y\\":" + Top + ",\\"width\\":" + Width + ",\\"height\\":" + Height + "}";
      File.WriteAllText(loadingBoundsPath, json, new UTF8Encoding(false));
    } catch {}
  }

  private static Size ReadSavedSize(string filePath, Size fallback) {
    try {
      var json = File.ReadAllText(filePath, Encoding.UTF8);
      var width = ReadNumber(json, "width");
      var height = ReadNumber(json, "height");
      if (width >= 320 && height >= 240 && width <= 32768 && height <= 32768) return new Size(width, height);
    } catch {}
    return fallback;
  }

  private static int ReadNumber(string json, string property) {
    var marker = "\\\"" + property + "\\\"";
    var offset = json.IndexOf(marker, StringComparison.OrdinalIgnoreCase);
    if (offset < 0) return 0;
    offset = json.IndexOf(':', offset + marker.Length);
    if (offset < 0) return 0;
    offset += 1;
    while (offset < json.Length && char.IsWhiteSpace(json[offset])) offset += 1;
    var end = offset;
    while (end < json.Length && char.IsDigit(json[end])) end += 1;
    int value;
    return int.TryParse(json.Substring(offset, end - offset), out value) ? value : 0;
  }
}

internal sealed class WhaleCanvas : Control {
  private readonly Bitmap whale;
  private readonly Font labelFont;
  private Thread animationThread;
  private readonly Stopwatch elapsed = Stopwatch.StartNew();
  private readonly string message;
  private readonly bool animationsEnabled;
  private int frameQueued;
  private volatile bool animationRunning;

  [DllImport("user32.dll")]
  private static extern bool SystemParametersInfo(uint action, uint parameter, out bool value, uint flags);

  [DllImport("dwmapi.dll")]
  private static extern int DwmFlush();

  internal WhaleCanvas(string messageValue, string imagePath) {
    message = messageValue;
    using (var source = Image.FromFile(imagePath)) whale = CreateTransparentWhale(source);
    labelFont = new Font("Segoe UI", 10.0f, FontStyle.Regular, GraphicsUnit.Point);
    SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint, true);
    BackColor = Color.FromArgb(21, 21, 23);
    bool enabled;
    animationsEnabled = !SystemParametersInfo(0x1042, 0, out enabled, 0) || enabled;
    if (animationsEnabled) {
      animationRunning = true;
      animationThread = new Thread(RenderLoop) { IsBackground = true, Name = "OMD DWM animation" };
      animationThread.Start();
    }
  }

  protected override void OnPaint(PaintEventArgs eventArguments) {
    base.OnPaint(eventArguments);
    var graphics = eventArguments.Graphics;
    graphics.SmoothingMode = SmoothingMode.AntiAlias;
    graphics.CompositingQuality = CompositingQuality.HighQuality;
    graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
    graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
    var scale = Math.Max(1.0f, graphics.DpiX / 96.0f);
    var seconds = elapsed.Elapsed.TotalSeconds;
    var breath = animationsEnabled ? (1.0 - Math.Cos((seconds % 4.8) / 4.8 * Math.PI * 2.0)) / 2.0 : 0.5;
    var iconScale = 0.985 + breath * 0.03;
    var iconSize = (float)(118.0 * iconScale * scale);
    var floatOffset = animationsEnabled ? (float)(-3.0 * breath * scale) : -1.5f * scale;
    var centerX = ClientSize.Width / 2.0f;
    var centerY = ClientSize.Height * 0.43f;
    var iconRect = new RectangleF(centerX - iconSize / 2.0f, centerY - iconSize / 2.0f + floatOffset, iconSize, iconSize);
    DrawWaterline(graphics, centerX, centerY + 49.0f * scale, seconds, breath, scale);
    graphics.DrawImage(whale, iconRect);
    DrawBubbles(graphics, iconRect, seconds, scale);

    var label = message;
    var labelSize = TextRenderer.MeasureText(label, labelFont);
    var dotsWidth = (int)(18.0f * scale);
    var labelX = (ClientSize.Width - labelSize.Width - dotsWidth) / 2;
    var labelY = (int)(centerY + 96.0f * scale);
    TextRenderer.DrawText(graphics, label, labelFont, new Point(labelX, labelY), Color.FromArgb(207, 211, 214), Color.Transparent);
    DrawDots(graphics, labelX + labelSize.Width + 3.0f * scale, labelY + labelSize.Height / 2.0f, seconds, scale);
  }

  protected override void Dispose(bool disposing) {
    if (disposing) {
      animationRunning = false;
      if (animationThread != null && Thread.CurrentThread != animationThread) animationThread.Join(250);
      animationThread = null;
      labelFont.Dispose();
      whale.Dispose();
    }
    base.Dispose(disposing);
  }

  private void RenderLoop() {
    while (animationRunning) {
      QueueFrame();
      if (DwmFlush() < 0) Thread.Sleep(8);
    }
  }

  private void QueueFrame() {
    if (IsDisposed || !IsHandleCreated || Interlocked.Exchange(ref frameQueued, 1) != 0) return;
    try {
      BeginInvoke((MethodInvoker)delegate {
        Interlocked.Exchange(ref frameQueued, 0);
        if (!IsDisposed) Invalidate();
      });
    } catch {
      Interlocked.Exchange(ref frameQueued, 0);
    }
  }

  private static Bitmap CreateTransparentWhale(Image source) {
    const int size = 256;
    var result = new Bitmap(size, size, PixelFormat.Format32bppArgb);
    using (var graphics = Graphics.FromImage(result)) {
      graphics.Clear(Color.Transparent);
      graphics.CompositingMode = CompositingMode.SourceCopy;
      graphics.CompositingQuality = CompositingQuality.HighQuality;
      graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
      graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
      graphics.DrawImage(source, new Rectangle(0, 0, size, size));
    }
    var rectangle = new Rectangle(0, 0, size, size);
    var data = result.LockBits(rectangle, ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
    try {
      var stride = data.Stride;
      var bytes = new byte[Math.Abs(stride) * size];
      Marshal.Copy(data.Scan0, bytes, 0, bytes.Length);
      for (var y = 0; y < size; y += 1) {
        var row = stride >= 0 ? y * stride : (size - 1 - y) * -stride;
        for (var x = 0; x < size; x += 1) {
          var offset = row + x * 4;
          if (x < 38 || x > 230 || y < 50 || y > 210) {
            bytes[offset + 3] = 0;
            continue;
          }
          var sourceAlpha = bytes[offset + 3];
          var luminance = (bytes[offset + 2] * 54 + bytes[offset + 1] * 183 + bytes[offset] * 19) >> 8;
          var darkness = 255 - luminance;
          if (sourceAlpha < 180 || darkness < 36) {
            bytes[offset + 3] = 0;
            continue;
          }
          var coverage = Math.Min(1.0, (darkness - 36) / 219.0);
          bytes[offset] = 186;
          bytes[offset + 1] = 194;
          bytes[offset + 2] = 196;
          bytes[offset + 3] = (byte)(coverage * 158.0);
        }
      }
      Marshal.Copy(bytes, 0, data.Scan0, bytes.Length);
    } finally {
      result.UnlockBits(data);
    }
    return result;
  }

  private void DrawWaterline(Graphics graphics, float centerX, float centerY, double seconds, double breath, float scale) {
    var baseWidth = (float)(118.0 * (0.92 + breath * 0.13) * scale);
    var baseHeight = 34.0f * scale;
    using (var pen = new Pen(Color.FromArgb((int)(18.0 + breath * 22.0), 199, 229, 247), Math.Max(1.0f, scale))) {
      graphics.DrawEllipse(pen, centerX - baseWidth / 2.0f, centerY - baseHeight / 2.0f, baseWidth, baseHeight);
    }
    for (var index = 0; index < 2; index += 1) {
      var phase = (seconds / 3.6 + index / 3.0) % 1.0;
      var opacity = Math.Sin(phase * Math.PI) * (1.0 - phase) * 44.0;
      var rippleWidth = (float)(118.0 * (0.70 + phase * 1.02) * scale);
      var rippleHeight = (float)(34.0 * (0.70 + phase * 0.88) * scale);
      using (var ripplePen = new Pen(Color.FromArgb(Math.Max(0, (int)opacity), 199, 229, 247), Math.Max(1.0f, scale))) {
        graphics.DrawEllipse(ripplePen, centerX - rippleWidth / 2.0f, centerY - rippleHeight / 2.0f, rippleWidth, rippleHeight);
      }
    }
  }

  private void DrawDots(Graphics graphics, float startX, float centerY, double seconds, float scale) {
    for (var index = 0; index < 3; index += 1) {
      var opacity = animationsEnabled
        ? 0.3 + 0.7 * ((Math.Sin(seconds * Math.PI * 2.2 - index * 0.75) + 1.0) / 2.0)
        : 0.7;
      var diameter = Math.Max(2.0f, 2.2f * scale);
      var x = startX + index * 5.0f * scale;
      using (var brush = new SolidBrush(Color.FromArgb((int)(opacity * 210.0), 207, 211, 214))) {
        graphics.FillEllipse(brush, x, centerY - diameter / 2.0f, diameter, diameter);
      }
    }
  }

  private void DrawBubbles(Graphics graphics, RectangleF iconRect, double seconds, float scale) {
    if (!animationsEnabled) return;
    var sizes = new float[] { 5.0f, 8.0f, 4.0f };
    var delays = new double[] { 0.25, 1.20, 2.10 };
    for (var index = 0; index < 3; index += 1) {
      var phase = (((seconds - delays[index]) % 3.3) + 3.3) % 3.3 / 3.3;
      if (phase < 0.12) continue;
      var progress = (phase - 0.12) / 0.88;
      var alpha = (int)(Math.Sin(progress * Math.PI) * 108.0);
      var size = sizes[index] * scale;
      var x = iconRect.Right - 22.0f * scale + (float)(progress * 18.0 * scale + Math.Sin(progress * Math.PI) * 3.0 * scale);
      var y = iconRect.Top + 25.0f * scale - (float)(progress * 34.0 * scale);
      using (var pen = new Pen(Color.FromArgb(Math.Max(0, alpha), 199, 229, 247), Math.Max(1.0f, scale))) {
        graphics.DrawEllipse(pen, x, y, size, size);
      }
    }
  }
}
`;
}
