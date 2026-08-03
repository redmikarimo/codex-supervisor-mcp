using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using Microsoft.Win32;

[assembly: AssemblyTitle("MCP Server")]
[assembly: AssemblyDescription("Biotele Codex MCP outbound local-agent launcher")]
[assembly: AssemblyProduct("MCP Server")]
[assembly: AssemblyCompany("Biotele")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

internal static class McpServerLauncher
{
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private static readonly string[] RequiredUserEnvironmentNames =
    {
        "BIOTELE_RELAY_BASE_URL",
        "BIOTELE_RELAY_AGENT_KEY_ID",
        "BIOTELE_RELAY_AGENT_SECRET",
        "CODEX_ALLOWED_ROOTS",
        "CODEX_ALLOW_NETWORK",
        "CODEX_BIN",
        "CODEX_APP_SERVER_ARGS"
    };

    private enum JobObjectInfoClass
    {
        JobObjectExtendedLimitInformation = 9
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectExtendedLimitInformation
    {
        public JobObjectBasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr securityAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        JobObjectInfoClass informationClass,
        IntPtr information,
        uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private static string QuoteArgument(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    private static IntPtr CreateKillOnCloseJob()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to create the MCP Server job object.");
        }

        var limits = new JobObjectExtendedLimitInformation();
        limits.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
        int size = Marshal.SizeOf(typeof(JobObjectExtendedLimitInformation));
        IntPtr pointer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(limits, pointer, false);
            if (!SetInformationJobObject(
                job,
                JobObjectInfoClass.JobObjectExtendedLimitInformation,
                pointer,
                (uint)size))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to configure the MCP Server job object.");
            }
        }
        catch
        {
            CloseHandle(job);
            throw;
        }
        finally
        {
            Marshal.FreeHGlobal(pointer);
        }
        return job;
    }

    private static void LoadRequiredUserEnvironment()
    {
        using (RegistryKey environment = Registry.CurrentUser.OpenSubKey("Environment", false))
        {
            if (environment == null)
            {
                throw new InvalidOperationException("The current user's Environment registry key is unavailable.");
            }

            foreach (string name in RequiredUserEnvironmentNames)
            {
                object stored = environment.GetValue(
                    name,
                    null,
                    RegistryValueOptions.DoNotExpandEnvironmentNames);
                string value = stored as string;
                if (String.IsNullOrWhiteSpace(value))
                {
                    throw new InvalidOperationException(
                        "Required user environment variable is missing: " + name);
                }
                Environment.SetEnvironmentVariable(
                    name,
                    value,
                    EnvironmentVariableTarget.Process);
            }
        }
    }

    public static int Main(string[] args)
    {
        if (args.Length != 3)
        {
            Console.Error.WriteLine("MCP Server launcher requires node.exe, local-agent.mjs, and working-directory paths.");
            return 64;
        }

        string nodePath = Path.GetFullPath(args[0]);
        string agentPath = Path.GetFullPath(args[1]);
        string workingDirectory = Path.GetFullPath(args[2]);
        if (!File.Exists(nodePath) || !File.Exists(agentPath) || !Directory.Exists(workingDirectory))
        {
            Console.Error.WriteLine("MCP Server launcher received a missing executable, agent, or working directory.");
            return 66;
        }

        IntPtr job = IntPtr.Zero;
        Process child = null;
        try
        {
            LoadRequiredUserEnvironment();
            job = CreateKillOnCloseJob();
            child = Process.Start(new ProcessStartInfo
            {
                FileName = nodePath,
                Arguments = QuoteArgument(agentPath),
                WorkingDirectory = workingDirectory,
                UseShellExecute = false,
                CreateNoWindow = true
            });
            if (child == null)
            {
                throw new InvalidOperationException("Node local agent did not start.");
            }
            if (!AssignProcessToJobObject(job, child.Handle))
            {
                int error = Marshal.GetLastWin32Error();
                try { child.Kill(); } catch { }
                throw new Win32Exception(error, "Unable to supervise the Node local agent in the MCP Server job object.");
            }
            child.WaitForExit();
            return child.ExitCode;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("MCP Server launcher failed: " + error.Message);
            return 1;
        }
        finally
        {
            if (child != null) child.Dispose();
            if (job != IntPtr.Zero) CloseHandle(job);
        }
    }
}
