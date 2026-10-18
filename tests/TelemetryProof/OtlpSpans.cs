using System.Text;

namespace TelemetryProof;

internal sealed record OtlpSpan(byte[] Trace, byte[] Id, byte[] Parent, string Name, long Kind);

internal static class OtlpSpans
{
    public static IEnumerable<OtlpSpan> Read(byte[] payload)
    {
        foreach (var resource in Fields(payload).Where(field => field.Number == 1))
            foreach (var scope in Fields(resource.Bytes).Where(field => field.Number == 2))
                foreach (var span in Fields(scope.Bytes).Where(field => field.Number == 2))
                {
                    var fields = Fields(span.Bytes).ToArray();
                    yield return new OtlpSpan(
                        fields.Single(field => field.Number == 1).Bytes,
                        fields.Single(field => field.Number == 2).Bytes,
                        fields.SingleOrDefault(field => field.Number == 4)?.Bytes ?? [],
                        Encoding.UTF8.GetString(fields.Single(field => field.Number == 5).Bytes),
                        fields.Single(field => field.Number == 6).Integer);
                }
    }

    private sealed record Field(int Number, byte[] Bytes, long Integer);

    private static IEnumerable<Field> Fields(byte[] message)
    {
        var offset = 0;
        while (offset < message.Length)
        {
            var tag = Varint(message, ref offset);
            var number = checked((int)(tag >> 3));
            switch (tag & 7)
            {
                case 0:
                    yield return new Field(number, [], checked((long)Varint(message, ref offset)));
                    break;
                case 1:
                    offset += 8;
                    break;
                case 2:
                    var length = checked((int)Varint(message, ref offset));
                    var bytes = message.AsSpan(offset, length).ToArray();
                    offset += length;
                    yield return new Field(number, bytes, 0);
                    break;
                case 5:
                    offset += 4;
                    break;
                default:
                    throw new InvalidDataException("Unsupported OTLP wire field.");
            }
            if (offset > message.Length)
                throw new InvalidDataException("Truncated OTLP payload.");
        }
    }

    private static ulong Varint(byte[] message, ref int offset)
    {
        ulong value = 0;
        for (var shift = 0; shift < 64; shift += 7)
        {
            var next = message[offset++];
            value |= (ulong)(next & 127) << shift;
            if ((next & 128) == 0)
                return value;
        }
        throw new InvalidDataException("Invalid OTLP varint.");
    }
}
