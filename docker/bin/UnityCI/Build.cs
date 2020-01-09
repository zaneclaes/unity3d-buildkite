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

    private static Dictionary<string, object> LoadArgs(params string[] args) {
      Dictionary<string, object> entries = new Dictionary<string, object>();
      string                     argName = null;
      foreach (string str in args) {
        if (str.StartsWith("--", StringComparison.InvariantCulture)) {
          argName = str.Substring(2);
        } else if (str.StartsWith("-", StringComparison.InvariantCulture)) {
          argName = str.Substring(1);
        } else {
          if (argName != null) AssignArg(argName, str, entries);
          argName = null;
        }
      }

      return entries;
    }

    // Assign an argument based upon its key/value to a dictionary
    private static void AssignArg(string key, object value, Dictionary<string, object> entries) {
      if (value is string val) {
        value = Environment.ExpandEnvironmentVariables(val);
      }
      if (key.Contains(".")) { // Sub-key (dictionary)
        string[] parts = key.Split('.');
        Dictionary<string, object> inner =
          entries.ContainsKey(parts[0]) ? entries[parts[0]] as Dictionary<string, object> : null;
        if (inner == null) {
          inner = new Dictionary<string, object>();
          entries.Add(parts[0], inner);
        }
        AssignArg(key.Substring(key.IndexOf('.') + 1), value, inner);
      } else if (key.EndsWith("[]")) { // List
        key = key.Substring(0, key.Length - 2);
        if (!entries.ContainsKey(key)) entries.Add(key, new List<object>());
        List<object> inner = entries[key] as List<object>;
        if (inner != null) inner.Add(value);
        else Debug.LogError($"{key} appeared first as a {entries[key].GetType()} and then as a list.");
      } else { // Other
        entries.Add(key, value);
      }
    }
  }
}
