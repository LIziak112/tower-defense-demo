using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

public static class TowerDefenseScreenProbe {
    [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct Mouse {
        public int X, Y; public uint Data, Flags, Time; public UIntPtr Extra;
    }
    [StructLayout(LayoutKind.Sequential)] struct Key {
        public ushort Code, Scan; public uint Flags, Time; public UIntPtr Extra;
    }
    [StructLayout(LayoutKind.Explicit)] struct Data {
        [FieldOffset(0)] public Mouse Mouse;
        [FieldOffset(0)] public Key Key;
    }
    [StructLayout(LayoutKind.Sequential)] struct Input { public uint Type; public Data Data; }
    public class Sample { public double VisibleMs, PollIntervalMs; }
    public class Result { public Sample[] Select, Cancel; }

    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] static extern int GetClassName(IntPtr window, StringBuilder name, int capacity);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int metric);
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr window);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr window, IntPtr dc);
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, Input[] items, int size);
    [DllImport("gdi32.dll")] static extern uint GetPixel(IntPtr dc, int x, int y);

    static readonly Input[] Click = {
        new Input { Data = new Data { Mouse = new Mouse { Flags = 0xc001 } } },
        new Input { Data = new Data { Mouse = new Mouse { Flags = 2 } } },
        new Input { Data = new Data { Mouse = new Mouse { Flags = 4 } } },
    };
    static readonly Input[] Escape = {
        new Input { Type = 1, Data = new Data { Key = new Key { Code = 27 } } },
        new Input { Type = 1, Data = new Data { Key = new Key { Code = 27, Flags = 2 } } },
    };
    const uint Selected = 0x8ae619, Idle = 0xe517c3;
    static readonly double MsPerTick = 1000.0 / Stopwatch.Frequency;

    static bool Matches(uint actual, uint expected) {
        if (actual == uint.MaxValue) return false;
        for (int shift = 0; shift < 24; shift += 8) {
            int a = (int)((actual >> shift) & 255), b = (int)((expected >> shift) & 255);
            if (Math.Abs(a - b) > 14) return false;
        }
        return true;
    }

    static bool ForegroundIs(IntPtr window) {
        IntPtr active = GetForegroundWindow();
        return active == window || GetAncestor(active, 2) == window;
    }

    static void Inject(Input[] input) {
        if (SendInput((uint)input.Length, input, Marshal.SizeOf(typeof(Input))) != input.Length)
            throw new InvalidOperationException("SendInput failed: " + Marshal.GetLastWin32Error());
    }

    static Sample Measure(IntPtr window, IntPtr dc, int x, int y, uint before, uint after, Input[] input) {
        if (!ForegroundIs(window)) throw new InvalidOperationException("Benchmark window lost foreground.");
        uint initial = GetPixel(dc, x, y);
        if (!Matches(initial, before)) throw new InvalidOperationException("Unexpected probe pixel before input: " + initial.ToString("X8"));
        long start = Stopwatch.GetTimestamp();
        Inject(input);
        long previous = start;
        while (true) {
            long readStart = Stopwatch.GetTimestamp();
            uint pixel = GetPixel(dc, x, y);
            long end = Stopwatch.GetTimestamp();
            if (Matches(pixel, after)) return new Sample {
                VisibleMs = (end - start) * MsPerTick, PollIntervalMs = (end - previous) * MsPerTick,
            };
            if ((end - start) * MsPerTick > 1000 || !ForegroundIs(window))
                throw new InvalidOperationException("Probe did not change after input. Last pixel: " + pixel.ToString("X8"));
            previous = readStart;
            Thread.Sleep(0);
        }
    }

    public static Result Run(long handle, int x, int y, int clickX, int clickY, int count) {
        IntPtr window = new IntPtr(handle);
        IntPtr dpi = SetThreadDpiAwarenessContext(new IntPtr(-4));
        IntPtr dc = GetDC(IntPtr.Zero);
        Point original;
        GetCursorPos(out original);
        try {
            if (dc == IntPtr.Zero) throw new InvalidOperationException("Could not obtain a screen device context.");
            Click[0].Data.Mouse.X = (int)Math.Round((clickX - GetSystemMetrics(76) + 0.5) * 65536 / GetSystemMetrics(78));
            Click[0].Data.Mouse.Y = (int)Math.Round((clickY - GetSystemMetrics(77) + 0.5) * 65536 / GetSystemMetrics(79));
            SetForegroundWindow(window);
            Thread.Sleep(100);
            if (!ForegroundIs(window)) {
                // Click to activate only after checking that the cursor position belongs to the test window.
                if (GetAncestor(WindowFromPoint(new Point { X = clickX, Y = clickY }), 2) != window) {
                    var name = new StringBuilder(128);
                    GetClassName(GetForegroundWindow(), name, name.Capacity);
                    throw new InvalidOperationException("Benchmark window could not be activated. Foreground class: " + name);
                }
                Inject(Click);
                Thread.Sleep(200);
                if (!ForegroundIs(window)) throw new InvalidOperationException("The benchmark window did not activate.");
                Inject(Escape);
                Thread.Sleep(200);
            }
            uint idle = GetPixel(dc, x, y);
            if (!Matches(idle, Idle)) throw new InvalidOperationException(
                "Idle probe pixel mismatch at " + x + "," + y + ": " + idle.ToString("X8"));
            if (!SetCursorPos(clickX, clickY)) throw new InvalidOperationException("Could not place cursor on benchmark tower.");
            Thread.Sleep(200);
            var result = new Result { Select = new Sample[count], Cancel = new Sample[count] };
            for (int i = 0; i < count; i++) {
                Thread.Sleep(19 + i * 17 % 31);
                if (GetAncestor(WindowFromPoint(new Point { X = clickX, Y = clickY }), 2) != window)
                    throw new InvalidOperationException("The benchmark tower is covered by another window.");
                result.Select[i] = Measure(window, dc, x, y, Idle, Selected, Click);
                Thread.Sleep(21 + i * 23 % 29);
                result.Cancel[i] = Measure(window, dc, x, y, Selected, Idle, Escape);
            }
            return result;
        } finally {
            Point current;
            if (GetCursorPos(out current) && Math.Abs(current.X - clickX) <= 1 && Math.Abs(current.Y - clickY) <= 1)
                SetCursorPos(original.X, original.Y);
            if (dc != IntPtr.Zero) ReleaseDC(IntPtr.Zero, dc);
            if (dpi != IntPtr.Zero) SetThreadDpiAwarenessContext(dpi);
        }
    }

    public static int Main(string[] args) {
        try {
            var result = Run(long.Parse(args[0]), int.Parse(args[1]), int.Parse(args[2]),
                int.Parse(args[3]), int.Parse(args[4]), int.Parse(args[5]));
            Console.WriteLine(new JavaScriptSerializer().Serialize(result));
            return 0;
        } catch (Exception error) {
            Console.Error.WriteLine(error.Message);
            return 1;
        }
    }
}
