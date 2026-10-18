import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInflateRaw, crc32 } from "node:zlib";
import {
  github,
  attemptJobs,
  runArtifacts,
  selectArtifact,
} from "./github.mjs";
import { requireCIEvidence } from "./policy.mjs";
import { producerLayout } from "./supply-evidence.mjs";
import { insist, proof, isolated, same, json } from "./supply-internal.mjs";

export const artifactLimits = Object.freeze({
  zip: 1024 * 1024 * 1024,
  expanded: 2 * 1024 * 1024 * 1024,
  archiveMember: 768 * 1024 * 1024,
  jsonMember: 32 * 1024 * 1024,
  directory: 64 * 1024,
});

export async function authenticateProducers(source, authority, trust) {
  insist(
    process.env.GH_TOKEN,
    "authenticated artifact membership requires GH_TOKEN",
  );
  const workflow = await github(
    `repos/ShiosOS/Damadama/actions/runs/${authority.runId}/attempts/${authority.attempt}`,
  );
  insist(
    workflow.id === authority.runId &&
      workflow.run_attempt === authority.attempt &&
      workflow.head_sha === source.commit &&
      workflow.head_sha === authority.sha &&
      workflow.event === "push" &&
      workflow.path === `.github/workflows/${trust.workflow}` &&
      workflow.head_branch === trust.ref.slice("refs/heads/".length) &&
      workflow.repository?.id === 1412858535 &&
      workflow.repository?.owner?.id === 31512984,
    "producer run identity differs",
  );
  const layouts = ["build", "scan"].map((role) => producerLayout(trust, role));
  const names = layouts.map((layout) => layout.job);
  if (trust === proof) names.push("proof-application-scan");
  const jobs = requireCIEvidence(
    source,
    await attemptJobs(authority),
    authority,
    names,
  );
  const artifacts = await runArtifacts(authority.runId);
  return layouts.map((layout, index) => {
    const job = jobs.find((job) => job.name === layout.job);
    const selected = selectArtifact(artifacts, layout.artifact, authority, job);
    const metadata = artifacts.find((artifact) => artifact.id === selected.id);
    insist(
      Number.isSafeInteger(metadata.size_in_bytes) &&
        metadata.size_in_bytes > 0 &&
        metadata.size_in_bytes <= artifactLimits.zip,
      "artifact ZIP metadata size exceeds bound",
    );
    return {
      role: ["build", "scan"][index],
      producer: { id: job.id, name: job.name },
      artifact: { ...selected, size: metadata.size_in_bytes },
    };
  });
}

async function downloadArtifact(artifact, path) {
  const response = await fetch(
    `https://api.github.com/repos/ShiosOS/Damadama/actions/artifacts/${artifact.id}/zip`,
    {
      headers: {
        Authorization: `Bearer ${process.env.GH_TOKEN}`,
        Accept: "application/vnd.github+json",
      },
      signal: AbortSignal.timeout(300_000),
    },
  );
  insist(
    response.ok && response.body,
    `artifact download failed ${response.status}`,
  );
  let size = 0;
  const digest = createHash("sha256");
  const bounded = new Transform({
    transform(bytes, encoding, callback) {
      size += bytes.length;
      if (size > artifact.size || size > artifactLimits.zip)
        return callback(new Error("artifact ZIP transport exceeds bound"));
      digest.update(bytes);
      callback(null, bytes);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body),
    bounded,
    createWriteStream(path, { flags: "wx", mode: 0o600 }),
  );
  insist(size === artifact.size, "artifact ZIP transport size differs");
  insist(
    `sha256:${digest.digest("hex")}` === artifact.digest,
    "artifact ZIP transport digest differs",
  );
}

async function readAt(file, offset, length) {
  const bytes = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await file.read(
      bytes,
      done,
      length - done,
      offset + done,
    );
    insist(bytesRead > 0, "truncated artifact ZIP");
    done += bytesRead;
  }
  return bytes;
}

async function zipMembers(path, expected) {
  const file = await open(path, "r");
  try {
    const size = (await file.stat()).size;
    insist(
      size >= 22 && size <= artifactLimits.zip,
      "artifact ZIP size exceeds bound",
    );
    const end = await readAt(file, size - 22, 22);
    insist(
      end.readUInt32LE(0) === 0x06054b50 &&
        end.readUInt16LE(4) === 0 &&
        end.readUInt16LE(6) === 0 &&
        end.readUInt16LE(20) === 0,
      "unsupported artifact ZIP end record",
    );
    const count = end.readUInt16LE(10);
    const length = end.readUInt32LE(12);
    const start = end.readUInt32LE(16);
    insist(
      count === expected.length &&
        end.readUInt16LE(8) === count &&
        length <= artifactLimits.directory &&
        start + length === size - 22,
      "artifact ZIP member set differs",
    );
    const central = await readAt(file, start, length);
    const members = new Map();
    const spans = [];
    let offset = 0;
    let expanded = 0;
    for (let index = 0; index < count; index++) {
      insist(
        offset + 46 <= central.length &&
          central.readUInt32LE(offset) === 0x02014b50,
        "invalid artifact ZIP central entry",
      );
      const header = central.subarray(offset, offset + 46);
      const flags = header.readUInt16LE(8);
      const method = header.readUInt16LE(10);
      const crc = header.readUInt32LE(16);
      const compressed = header.readUInt32LE(20);
      const unpacked = header.readUInt32LE(24);
      const nameLength = header.readUInt16LE(28);
      const extraLength = header.readUInt16LE(30);
      const commentLength = header.readUInt16LE(32);
      const localOffset = header.readUInt32LE(42);
      const endOffset = offset + 46 + nameLength + extraLength + commentLength;
      insist(
        endOffset <= central.length &&
          extraLength === 0 &&
          commentLength === 0 &&
          header.readUInt16LE(34) === 0,
        "unsupported artifact ZIP entry metadata",
      );
      const name = central
        .subarray(offset + 46, offset + 46 + nameLength)
        .toString("utf8");
      insist(
        expected.includes(name) && !members.has(name),
        "duplicate, missing or unknown artifact ZIP member",
      );
      const mode = header.readUInt32LE(38) >>> 16;
      insist(
        ((mode & 0xf000) === 0x8000 || mode === 0) &&
          (header.readUInt16LE(38) & ~0x20) === 0,
        "artifact ZIP alias is forbidden",
      );
      insist(
        (flags & ~0x808) === 0 && (method === 0 || method === 8),
        "unsupported artifact ZIP encoding",
      );
      const maximum = name.endsWith(".tar")
        ? artifactLimits.archiveMember
        : artifactLimits.jsonMember;
      expanded += unpacked;
      insist(
        unpacked > 0 &&
          unpacked <= maximum &&
          expanded <= artifactLimits.expanded &&
          compressed > 0,
        "artifact ZIP expansion exceeds bound",
      );
      insist(localOffset + 30 < start, "invalid artifact ZIP local offset");
      const local = await readAt(file, localOffset, 30);
      insist(
        local.readUInt32LE(0) === 0x04034b50 &&
          local.readUInt16LE(6) === flags &&
          local.readUInt16LE(8) === method &&
          local.readUInt16LE(26) === nameLength &&
          local.readUInt16LE(28) === 0,
        "artifact ZIP local header differs",
      );
      insist(
        (await readAt(file, localOffset + 30, nameLength)).equals(
          Buffer.from(name),
        ),
        "artifact ZIP local member differs",
      );
      const data = localOffset + 30 + nameLength;
      let finish = data + compressed;
      insist(finish <= start, "artifact ZIP member overlaps directory");
      if (flags & 8) {
        const descriptor = await readAt(file, finish, 16);
        insist(
          descriptor.readUInt32LE(0) === 0x08074b50 &&
            descriptor.readUInt32LE(4) === crc &&
            descriptor.readUInt32LE(8) === compressed &&
            descriptor.readUInt32LE(12) === unpacked,
          "artifact ZIP data descriptor differs",
        );
        finish += 16;
        insist(
          local.readUInt32LE(14) === 0 &&
            local.readUInt32LE(18) === 0 &&
            local.readUInt32LE(22) === 0,
          "artifact ZIP streaming header differs",
        );
      } else
        insist(
          local.readUInt32LE(14) === crc &&
            local.readUInt32LE(18) === compressed &&
            local.readUInt32LE(22) === unpacked,
          "artifact ZIP local sizes differ",
        );
      spans.push([localOffset, finish]);
      members.set(name, { data, compressed, unpacked, method, crc });
      offset = endOffset;
    }
    insist(
      offset === central.length && members.size === expected.length,
      "artifact ZIP directory differs",
    );
    let previous = 0;
    for (const [begin, finish] of spans.sort((a, b) => a[0] - b[0])) {
      insist(
        begin === previous && finish <= start,
        "artifact ZIP overlapping or unlisted local member",
      );
      previous = finish;
    }
    insist(previous === start, "artifact ZIP unlisted data");
    return members;
  } finally {
    await file.close();
  }
}

async function extractMember(archive, member, output) {
  await mkdir(dirname(output), { recursive: true });
  let size = 0;
  let crc = 0;
  const bounded = new Transform({
    transform(bytes, encoding, callback) {
      size += bytes.length;
      if (size > member.unpacked)
        return callback(new Error("artifact ZIP member output exceeds bound"));
      crc = crc32(bytes, crc);
      callback(null, bytes);
    },
  });
  const streams = [
    createReadStream(archive, {
      start: member.data,
      end: member.data + member.compressed - 1,
    }),
  ];
  if (member.method === 8) streams.push(createInflateRaw());
  await pipeline(
    ...streams,
    bounded,
    createWriteStream(output, { flags: "wx", mode: 0o600 }),
    { signal: AbortSignal.timeout(300_000) },
  );
  insist(
    size === member.unpacked && crc === member.crc,
    "artifact ZIP member size or CRC differs",
  );
}

export async function extractProducerZip(
  archive,
  role,
  trust,
  directory,
  source,
  authority,
) {
  const layout = producerLayout(trust, role);
  const members = await zipMembers(archive, layout.members);
  await mkdir(join(directory, role));
  for (const selected of layout.selected)
    await extractMember(
      archive,
      members.get(selected.member),
      join(directory, selected.path),
    );
  if (layout.identity)
    await isolated(async (scratch) => {
      const path = join(scratch, "identity.json");
      await extractMember(archive, members.get(layout.identity), path);
      insist(
        same(await json(path), { source, authority }),
        "original producer identity differs",
      );
    });
}

export async function materializeProducers(
  source,
  authority,
  trust,
  directory,
) {
  const producers = await authenticateProducers(source, authority, trust);
  await mkdir(directory, { recursive: true });
  for (const producer of producers)
    await isolated(async (scratch) => {
      const archive = join(scratch, "artifact.zip");
      await downloadArtifact(producer.artifact, archive);
      insist(
        (await stat(archive)).size === producer.artifact.size,
        "artifact ZIP size changed",
      );
      await extractProducerZip(
        archive,
        producer.role,
        trust,
        directory,
        source,
        authority,
      );
    });
  return producers;
}
