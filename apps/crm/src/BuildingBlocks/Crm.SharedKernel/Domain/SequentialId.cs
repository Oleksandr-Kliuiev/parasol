using System.Security.Cryptography;

namespace Crm.SharedKernel.Domain;

/// <summary>
/// Generates GUIDs that are sequential in SQL Server's uniqueidentifier sort order
/// (SQL Server compares bytes 10–15 first). UUID v7 is not sequential there and fragments clustered indexes.
/// </summary>
public static class SequentialId
{
    private static long _lastTimestamp;
    private static int _counter;
    private static readonly Lock Gate = new();

    public static Guid New() => New(DateTimeOffset.UtcNow);

    public static Guid New(DateTimeOffset now)
    {
        Span<byte> bytes = stackalloc byte[16];
        RandomNumberGenerator.Fill(bytes[..8]);

        long timestamp = now.ToUnixTimeMilliseconds();
        int counter;
        lock (Gate)
        {
            if (timestamp <= _lastTimestamp)
            {
                timestamp = _lastTimestamp;
                _counter = (_counter + 1) & 0xFFFF;
                if (_counter == 0)
                {
                    timestamp = ++_lastTimestamp;
                }
            }
            else
            {
                _lastTimestamp = timestamp;
                _counter = 0;
            }

            counter = _counter;
        }

        // Bytes 8–9: counter (compared after 10–15), bytes 10–15: 48-bit big-endian millisecond timestamp.
        bytes[8] = (byte)(counter >> 8);
        bytes[9] = (byte)counter;
        for (int i = 0; i < 6; i++)
        {
            bytes[15 - i] = (byte)(timestamp >> (8 * i));
        }

        return new Guid(bytes);
    }
}
