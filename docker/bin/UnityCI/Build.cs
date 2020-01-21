using System;
using System.Collections.Generic;
using UnityEngine;

namespace Editor.UnityCI {
  public static class Build {
    public static void Compile() {
      Debug.Log("Build.Compile started.");
      BuildApp builder = new BuildApp(LoadArgs(Environment.GetCommandLineArgs()));
      builder.Build();
    }

    private static Dictionary<string, string> LoadArgs(params string[] args) {
      Dictionary<string, string> entries = new Dictionary<string, string>();
      string                     argName = null;
      foreach (string str in args) {
        if (str.StartsWith("--", StringComparison.InvariantCulture)) {
          argName = str.Substring(2);
        } else if (str.StartsWith("-", StringComparison.InvariantCulture)) {
          argName = str.Substring(1);
        } else {
          if (argName != null)
            entries.Add(argName, Environment.ExpandEnvironmentVariables(str));
          argName = null;
        }
      }

      return entries;
    }
  }
}
