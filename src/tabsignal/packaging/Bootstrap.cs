using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Windows.Forms;

internal static class Bootstrap
{
    [STAThread]
    private static int Main(string[] args)
    {
        bool verify = args.Length == 1 && args[0] == "/verify";
        if (args.Length != 0 && !verify) return 2;
        if (!verify && MessageBox.Show("Install TabSignal Companion for this Windows account?\n\nThis connects the TabSignal extension to Discord Desktop. Sharing remains controlled by the extension. Close Chrome and Brave before upgrading.", "TabSignal Companion", MessageBoxButtons.OKCancel, MessageBoxIcon.Information) != DialogResult.OK) return 0;
        string temporary = Path.Combine(Path.GetTempPath(), "TabSignal-" + Guid.NewGuid().ToString("N"));
        try
        {
            Directory.CreateDirectory(temporary);
            using (Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
            using (ZipArchive archive = new ZipArchive(stream, ZipArchiveMode.Read))
            {
                string boundary = Path.GetFullPath(temporary) + Path.DirectorySeparatorChar;
                foreach (ZipArchiveEntry entry in archive.Entries)
                {
                    string target = Path.GetFullPath(Path.Combine(temporary, entry.FullName));
                    if (!target.StartsWith(boundary, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Invalid package path.");
                    if (entry.Name.Length == 0) continue;
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    entry.ExtractToFile(target, false);
                }
            }
            string script = Path.Combine(temporary, "setup.ps1");
            string powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe");
            ProcessStartInfo start = new ProcessStartInfo(powershell);
            start.Arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" + script + "\" -Mode " + (verify ? "Verify" : "Install") + " -PackageRoot \"" + temporary + "\"";
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.WindowStyle = ProcessWindowStyle.Hidden;
            start.RedirectStandardOutput = true;
            start.RedirectStandardError = true;
            start.EnvironmentVariables["PSModulePath"] = Path.Combine(Path.GetDirectoryName(powershell), "Modules");
            using (Process process = Process.Start(start))
            {
                var output = process.StandardOutput.ReadToEndAsync();
                var error = process.StandardError.ReadToEndAsync();
                process.WaitForExit();
                if (process.ExitCode != 0) throw new InvalidOperationException(error.Result.Trim());
                if (!verify) MessageBox.Show("TabSignal Companion is installed.\n\nOpen Chrome or Brave, open TabSignal and choose Check connection. You can remove the companion from Windows Installed apps.", "TabSignal Companion", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return 0;
            }
        }
        catch (Exception error)
        {
            if (verify) Console.Error.WriteLine(error.ToString());
            if (!verify) MessageBox.Show("Setup could not finish.\n\n" + error.Message, "TabSignal Companion", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
        finally
        {
            try { if (Directory.Exists(temporary)) Directory.Delete(temporary, true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }
}
