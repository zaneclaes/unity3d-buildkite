using System.Collections.Generic;
using DataSculpt.Config;
using DataSculpt.Config.Loaders;
using DataSculptUnityEditor.CI;
using UnityEngine;

namespace Editor.UnityCI {
  public static class Build {
    public static void Compile() {
      Debug.Log("Build.Compile started.");
      BuildApp builder = new BuildApp();
      builder.ConfigManager.Register(builder, new List<IConfigLoader>() {
        new EnvironmentConfigLoader(),
        new CommandLineConfigLoader()
      });
      Debug.Log("Starting BuildApp...");
      builder.Start().Wait();
      builder.Log.Information("Ready to build.");
      builder.Build();
    }
  }
}
