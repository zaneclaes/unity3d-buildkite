using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.Build.Reporting;
using UnityEngine;

namespace Editor.UnityCI {
  public class BuildApp {
    public string Name { get; set; }

    public string OutputDir { get; set; }

    public string BuildTarget { get; set; }

    public List<string> Scenes { get; set; } = new List<string>();

    public string ReportFile { get; set; }

    public BuildTarget UnityBuildTarget => (BuildTarget) Enum.Parse(typeof(BuildTarget), BuildTarget);

    public string Version { get; set; }

    public string Commit { get; set; }

    public string AndroidSdkRoot { get; set; }

    public string JdkPath { get; set; }

    public string LogFormat { get; set; } =
      "[Build] [{Level}] [{Timestamp:HH:mm:ss:ffffff}] {Message}{NewLine}{Properties}{NewLine}{Exception}";

    private SemVersion _version;

    public void Build() {
      if (!string.IsNullOrWhiteSpace(_version.ToString())) {
        Debug.LogFormat("[Build] Writing {version} to Assets/Resources/Version.txt", _version);
        File.WriteAllText("Assets/Resources/Version.txt", _version.ToString());
      }
      if (!string.IsNullOrWhiteSpace(Commit)) {
        Debug.LogFormat("[Build] Writing {text} to {file}", Commit, "Assets/Resources/Commit.txt");
        File.WriteAllText("Assets/Resources/Commit.txt", Commit);
      }
      Debug.LogFormat("[Build] Refreshing assets for {target}", this);
      AssetDatabase.Refresh(ImportAssetOptions.ForceUpdate);
      Debug.LogFormat($"[Build] Asset Refresh Complete.");
      BuildTarget bt = UnityBuildTarget;
      string[] scenes = Scenes.ToArray();
      Debug.LogFormat("[Build] Building {type} to {path}", this, OutputDir);
      ClearFolder(OutputDir);
      Directory.CreateDirectory(OutputDir); // already recursive
      PreProcess(bt);
      string outputPath = Path.Combine(OutputDir, Name);
      Debug.LogFormat("[Build] BuildPipeline.BuildPlayer {scenes} => {path}", string.Join(", ", scenes), outputPath);
      BuildReport report = BuildPipeline.BuildPlayer(scenes, outputPath, bt, BuildOptions.SymlinkLibraries);
      if (!string.IsNullOrEmpty(ReportFile)) {
        Debug.LogFormat("[Build] Writing {name} to {path}", report.summary.result, ReportFile);
        List<string> errors = report.steps.SelectMany(
          s => s.messages.Where(m => m.type == LogType.Error).Select(m => m.content)).ToList();
        File.WriteAllText(ReportFile, JsonUtility.ToJson(new Dictionary<string, string>() {
          {"result", report.summary.result.ToString()},
          {"outputPath", report.summary.outputPath},
          {"totalErrors", report.summary.totalErrors.ToString()},
          {"totalWarnings", report.summary.totalWarnings.ToString()},
          {"totalSize", report.summary.totalSize.ToString()},
          {"totalTime", report.summary.totalTime.ToString()},
          {"buildStartedAt", report.summary.buildStartedAt.ToString()},
          {"buildEndedAt", report.summary.buildEndedAt.ToString()},
          {"errors", string.Join("\n", errors)}
        }));
      }
    }

    private void ClearFolder(string FolderName) {
      DirectoryInfo dir = new DirectoryInfo(FolderName);
      if (!dir.Exists) return;

      foreach (FileInfo fi in dir.GetFiles()) {
        fi.IsReadOnly = false;
        fi.Delete();
      }

      foreach (DirectoryInfo di in dir.GetDirectories()) {
        ClearFolder(di.FullName);
        di.Delete();
      }
    }

    private void PreProcess(BuildTarget bt) {
      Debug.LogFormat("[Build] Checking pre-conditions for {name}.", bt);
      if (bt == UnityEditor.BuildTarget.WebGL) {
        if (PlayerSettings.WebGL.template != "PROJECT:MGFullWindow") {
          throw new Exception("Incorrect template: " + PlayerSettings.WebGL.template);
        }
      }

      if (bt == UnityEditor.BuildTarget.Android) {
        if (!string.IsNullOrEmpty(AndroidSdkRoot)) {
          if (!Directory.Exists(AndroidSdkRoot)) {
            Debug.LogWarningFormat("[Build] Missing androidSdkRoot at {path}", AndroidSdkRoot);
          } else {
            Debug.LogFormat(
              "[Build] Setting AndroidSdkRoot to {path}", AndroidSdkRoot);
            EditorPrefs.SetString("AndroidSdkRoot", AndroidSdkRoot);
          }
        }
        if (!string.IsNullOrEmpty(JdkPath)) {
          if (!Directory.Exists(JdkPath)) {
            Debug.LogWarningFormat("[Build] Missing jdkRoot at {path}", JdkPath);
          } else {
            Debug.LogFormat("[Build] Setting JdkPath to {path}", JdkPath);
            EditorPrefs.SetString("JdkPath", JdkPath);
          }
        }

        PlayerSettings.Android.bundleVersionCode = _version.Major * 10000 +
                                                   _version.Minor * 100 +
                                                   _version.Patch;
        Debug.LogFormat("[Build] Using Android bundleVersionCode #{name} w/ SDK: {path}",
          PlayerSettings.Android.bundleVersionCode, EditorPrefs.GetString("AndroidSdkRoot"));
      }

      if (bt == UnityEditor.BuildTarget.Android || bt == UnityEditor.BuildTarget.iOS) {
        Debug.LogFormat("[Build] Setting PlayerSettings.bundleVersion to {name}", _version.MajorMinorPatch);
        PlayerSettings.bundleVersion = _version.MajorMinorPatch.ToString();
      }
      if (bt == UnityEditor.BuildTarget.iOS) {
        PlayerSettings.iOS.buildNumber = _version.Build;
        PlayerSettings.SetArchitecture(BuildTargetGroup.iOS, 1); // ARM64
        Debug.LogFormat("[Build] Using iOS buildNumber {name}", PlayerSettings.iOS.buildNumber);
      }
    }

    public BuildApp(Dictionary<string, object> args) {
      if (string.IsNullOrEmpty(Name)) {
        throw new ArgumentNullException(nameof(Name));
      }
      if (string.IsNullOrEmpty(BuildTarget)) {
        throw new ArgumentNullException(nameof(BuildTarget));
      }
      if (string.IsNullOrEmpty(OutputDir)) {
        OutputDir = "bin/";
      }
      if (!Scenes.Any()) {
        throw new ArgumentNullException(nameof(Scenes));
      }
      if (string.IsNullOrEmpty(Version)) {
        throw new ArgumentNullException(nameof(Version));
      }
      _version = SemVersion.Parse(Version);
    }

    public override string ToString() {
      return $"<{Name} bin={OutputDir} BuildTarget={BuildTarget} scenes={string.Join(", ", Scenes)} >";
    }
  }
}
