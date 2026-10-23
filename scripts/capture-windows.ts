import { dlopen } from "bun:ffi";

const { symbols } = dlopen("kernel32.dll", {
  CreateJobObjectW: { args: ["ptr", "buffer"], returns: "ptr" },
  OpenJobObjectW: { args: ["u32", "i32", "buffer"], returns: "ptr" },
  SetInformationJobObject: {
    args: ["ptr", "i32", "buffer", "u32"],
    returns: "i32",
  },
  QueryInformationJobObject: {
    args: ["ptr", "i32", "buffer", "u32", "ptr"],
    returns: "i32",
  },
  GetCurrentProcess: { args: [], returns: "ptr" },
  AssignProcessToJobObject: { args: ["ptr", "ptr"], returns: "i32" },
  TerminateJobObject: { args: ["ptr", "u32"], returns: "i32" },
  CloseHandle: { args: ["ptr"], returns: "i32" },
});

function checked<T>(value: T): NonNullable<T> {
  if (!value) throw new Error("Capture ownership operation failed.");
  return value;
}

function wide(value: string): Buffer {
  return Buffer.from(`${value}\0`, "utf16le");
}

export function createJob(): {
  name: string;
  terminate: () => void;
  empty: () => boolean;
  close: () => void;
} {
  const name = `Local\\DamadamaCapture-${crypto.randomUUID()}`;
  const handle = checked(symbols.CreateJobObjectW(null, wide(name)));
  try {
    // Windows x64 JOBOBJECT_EXTENDED_LIMIT_INFORMATION, with no breakaway.
    const limits = Buffer.alloc(144);
    limits.writeUInt32LE(0x2000, 16);
    checked(symbols.SetInformationJobObject(handle, 9, limits, limits.length));
  } catch (error) {
    checked(symbols.CloseHandle(handle));
    throw error;
  }
  return {
    name,
    terminate(): void {
      checked(symbols.TerminateJobObject(handle, 1));
    },
    empty(): boolean {
      const accounting = Buffer.alloc(48);
      checked(
        symbols.QueryInformationJobObject(handle, 1, accounting, 48, null),
      );
      return accounting.readUInt32LE(40) === 0;
    },
    close(): void {
      checked(symbols.CloseHandle(handle));
    },
  };
}

export function joinJob(name: string): void {
  const handle = checked(symbols.OpenJobObjectW(0x0001, 0, wide(name)));
  try {
    checked(
      symbols.AssignProcessToJobObject(handle, symbols.GetCurrentProcess()),
    );
  } finally {
    checked(symbols.CloseHandle(handle));
  }
}
