import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { extractProducerZip, artifactLimits } from "./supply-producers.mjs";
import {
  producerLayout,
  evidenceFiles,
  evidenceGroups,
  manifestFiles,
  releaseMembers,
} from "./supply-evidence.mjs";
import { compareOriginals } from "./supply-chain.mjs";
import { proof, production, installScopes } from "./supply-internal.mjs";

const source = {
  repository: "ShiosOS/Damadama",
  commit: "a".repeat(40),
  tree: "b".repeat(40),
};
const authority = { sha: source.commit, runId: 123, attempt: 2 };

function zip(entries) {
  const data = [];
  const records = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const bytes = Buffer.from(entry.content ?? "{}");
    const compressed = deflateRawSync(bytes);
    const crc = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(name.length, 26);
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(compressed.length, 8);
    descriptor.writeUInt32LE(bytes.length, 12);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50);
    record.writeUInt16LE(0x32d, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(8, 8);
    record.writeUInt16LE(8, 10);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(compressed.length, 20);
    record.writeUInt32LE(entry.declaredSize ?? bytes.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(entry.attributes ?? 0x81a40000, 38);
    record.writeUInt32LE(offset, 42);
    data.push(local, name, compressed, descriptor);
    records.push(record, name);
    offset +=
      local.length + name.length + compressed.length + descriptor.length;
  }
  const central = Buffer.concat(records);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...data, central, end]);
}

function entries(role) {
  return producerLayout(proof, role).members.map((name) => ({
    name,
    content:
      name === "identity.json"
        ? JSON.stringify({ source, authority })
        : JSON.stringify({ original: name }),
  }));
}

test("original ZIP extraction fills partial file reads and refuses zero-byte EOF", () => {
  const encoded = zip(entries("build")).toString("base64");
  const script = `
    import { mock } from 'node:test';
    import assert from 'node:assert/strict';
    import * as fs from 'node:fs/promises';
    import { join } from 'node:path';
    import { tmpdir } from 'node:os';
    let eof = false, reads = 0;
    mock.module('node:fs/promises', { namedExports: { ...fs, open: async (...args) => {
      const file = await fs.open(...args);
      return {
        stat: () => file.stat(), close: () => file.close(),
        read: async (bytes, offset, length, position) => {
          reads++;
          if (eof && reads === 2) return { bytesRead: 0, buffer: bytes };
          return file.read(bytes, offset, Math.min(length, 3), position);
        },
      };
    } } });
    const { extractProducerZip } = await import('./release/supply-producers.mjs');
    const { proof } = await import('./release/supply-internal.mjs');
    const { producerLayout } = await import('./release/supply-evidence.mjs');
    const root = await fs.mkdtemp(join(tmpdir(), 'supply-short-read-'));
    try {
      const path = join(root, 'original.zip');
      await fs.writeFile(path, Buffer.from('${encoded}', 'base64'));
      const output = join(root, 'partial');
      await fs.mkdir(output);
      await extractProducerZip(path, 'build', proof, output, ${JSON.stringify(source)}, ${JSON.stringify(authority)});
      for (const selected of producerLayout(proof, 'build').selected)
        assert.deepEqual(JSON.parse(await fs.readFile(join(output, selected.path))), { original: selected.member });
      assert(reads > 2);
      eof = true; reads = 0;
      const truncated = join(root, 'eof');
      await fs.mkdir(truncated);
      await assert.rejects(extractProducerZip(path, 'build', proof, truncated, ${JSON.stringify(source)}, ${JSON.stringify(authority)}), /truncated artifact ZIP/);
      assert.equal(reads, 2);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  `;
  execFileSync(
    process.execPath,
    ["--experimental-test-module-mocks", "--input-type=module", "-e", script],
    { stdio: "pipe" },
  );
});

test("fixed original ZIP extraction owns build and scan paths and rejects malformed membership", async () => {
  const root = await mkdtemp(join(tmpdir(), "supply-zip-"));
  try {
    for (const role of ["build", "scan"]) {
      const archive = join(root, `${role}.zip`);
      await writeFile(archive, zip(entries(role)));
      const directory = join(root, role);
      await mkdir(directory);
      await extractProducerZip(
        archive,
        role,
        proof,
        directory,
        source,
        authority,
      );
      for (const selected of producerLayout(proof, role).selected)
        assert.deepEqual(
          JSON.parse(await readFile(join(directory, selected.path))),
          { original: selected.member },
        );
    }
    let index = 0;
    const good = entries("build");
    const cases = [
      good.slice(1),
      good.map((entry, i) => (i === 1 ? good[0] : entry)),
      good.map((entry, i) =>
        i === 1 ? { ...entry, name: "../escape.json" } : entry,
      ),
      good.map((entry, i) =>
        i === 1 ? { ...entry, attributes: 0xa1ff0000 } : entry,
      ),
      good.map((entry) =>
        entry.name === "paired-clean/web-build.json"
          ? { ...entry, declaredSize: artifactLimits.jsonMember + 1 }
          : entry,
      ),
      good.map((entry) =>
        entry.name === "identity.json"
          ? {
              ...entry,
              content: JSON.stringify({
                source,
                authority: { ...authority, attempt: 3 },
              }),
            }
          : entry,
      ),
    ];
    for (const bad of cases) {
      const archive = join(root, `bad-${index}.zip`);
      const output = join(root, `bad-${index++}`);
      await mkdir(output);
      await writeFile(archive, zip(bad));
      await assert.rejects(
        extractProducerZip(archive, "build", proof, output, source, authority),
      );
    }
    const corrupted = zip(good);
    corrupted[30 + good[0].name.length] ^= 0xff;
    const path = join(root, "corrupt.zip");
    await writeFile(path, corrupted);
    const output = join(root, "corrupt");
    await mkdir(output);
    await assert.rejects(
      extractProducerZip(path, "build", proof, output, source, authority),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("every mandatory group is hashed and original ownership cannot be replaced by a scanner mirror", async () => {
  const root = await mkdtemp(join(tmpdir(), "supply-members-"));
  try {
    const capsule = join(root, "capsule");
    const original = join(root, "original");
    for (const directory of [capsule, original])
      for (const name of evidenceFiles) {
        const path = join(directory, name);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, name);
      }
    assert.equal(
      Object.keys(await manifestFiles(capsule)).length,
      evidenceFiles.length,
    );
    await compareOriginals(capsule, original);
    for (const group of ["build", "scan"])
      for (const name of evidenceGroups[group]) {
        const path = join(capsule, group, name);
        await writeFile(path, "changed");
        await assert.rejects(
          compareOriginals(capsule, original),
          /original .* member differs/,
        );
        await writeFile(path, `${group}/${name}`);
      }
    for (const name of evidenceFiles) {
      const path = join(capsule, name);
      await rm(path);
      await assert.rejects(manifestFiles(capsule), /ENOENT/);
      await writeFile(path, name);
    }
    assert.throws(
      () => producerLayout({ ...proof }, "build"),
      /unknown supply trust/,
    );
    assert.throws(
      () => producerLayout(proof, "../scan"),
      /unknown producer role/,
    );
    assert(
      !producerLayout(production, "build").members.some((name) =>
        name.startsWith("paired-clean/"),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("both verifier entry points reject schema1 after the signature boundary; mocked transport is not crypto proof", () => {
  const script = `
    import { mock } from 'node:test';
    import assert from 'node:assert/strict';
    import { mkdtemp, writeFile, rm } from 'node:fs/promises';
    import { join } from 'node:path';
    import { tmpdir } from 'node:os';
    import * as internal from './release/supply-internal.mjs';
    let verified = 0;
    mock.module('./release/supply-internal.mjs', { namedExports: { ...internal, verifySignature: async () => { verified++; } } });
    const { verifyCIProof, verifyRelease } = await import('./release/supply-chain.mjs');
    const directory = await mkdtemp(join(tmpdir(), 'supply-schema-'));
    try {
      const source = ${JSON.stringify(source)}, authority = ${JSON.stringify(authority)};
      for (const [verify, purpose] of [[verifyCIProof, internal.proof.purpose], [verifyRelease, internal.production.purpose]]) {
        await writeFile(join(directory, 'manifest.json'), JSON.stringify({ schema: 1, purpose }));
        await writeFile(join(directory, 'manifest.bundle.json'), '{}');
        await assert.rejects(verify({ expectedSource: source, expectedAuthority: authority, expectedImage: { digest: 'sha256:'+'a'.repeat(64), reference: 'ghcr.io/shiosos/damadama@sha256:'+'a'.repeat(64), archiveSha256: 'b'.repeat(64), version: 'main-aaaaaaaaaaaa' }, evidenceDirectory: directory }), /schema1 is unsupported/);
      }
      assert.equal(verified, 2);
    } finally { await rm(directory, { recursive: true, force: true }); }
  `;
  execFileSync(
    process.execPath,
    ["--experimental-test-module-mocks", "--input-type=module", "-e", script],
    { stdio: "pipe" },
  );
});

test("signer installs only verification and reconstruction tools and depends on the application gate", async () => {
  assert.deepEqual(installScopes.signer, ["gh", "crane"]);
  assert(!installScopes.verifier.includes("syft"));
  const workflow = await readFile(
    new URL("../.github/workflows/supply-chain-proof.yml", import.meta.url),
    "utf8",
  );
  const signer = workflow.split("  proof-sign:")[1].split("  proof-verify:")[0];
  assert(
    signer.includes("needs: [proof-build, proof-scan, proof-application-scan]"),
  );
  assert(signer.includes("node release/supply-install.mjs signer"));
  assert(!/supply-install.mjs(?:\r?\n| scanner)/.test(signer));
  assert(signer.includes("subject-path: .audit/proof-signed/build/image.tar"));
  assert(signer.includes("sbom-path: .audit/proof-signed/scan/sbom.spdx.json"));
});
test("producer authentication streams complete ZIPs and refuses transport or producer substitutions", () => {
  const archives = Object.fromEntries(
    ["build", "scan"].map((role) => [
      role,
      zip(entries(role)).toString("base64"),
    ]),
  );
  const script = `
    import { mock } from 'node:test';
    import assert from 'node:assert/strict';
    import { mkdtemp, rm } from 'node:fs/promises';
    import { join } from 'node:path';
    import { tmpdir } from 'node:os';
    import * as github from './release/github.mjs';
    import { hash, proof } from './release/supply-internal.mjs';
    const source=${JSON.stringify(source)}, authority=${JSON.stringify(authority)};
    const archives=${JSON.stringify(archives)};
    const bytes=Object.fromEntries(Object.entries(archives).map(([role,value])=>[role,Buffer.from(value,'base64')]));
    const jobs=['proof-build','proof-scan','proof-application-scan'].map((name,i)=>({ id:i+10,name,head_sha:source.commit,run_id:authority.runId,run_attempt:authority.attempt,status:'completed',conclusion:'success',html_url:'https://github.com/ShiosOS/Damadama/actions/runs/123/job/'+(i+10),started_at:'2026-10-18T00:00:00Z',completed_at:'2026-10-18T00:02:00Z' }));
    const workflow={id:123,run_attempt:2,head_sha:source.commit,event:'push',path:'.github/workflows/supply-chain-proof.yml',head_branch:'codex/polish-image-supply-chain',repository:{id:1412858535,owner:{id:31512984}}};
    const artifacts=['build','scan'].map((role,i)=>({id:i+1,name:'supply-proof-'+role+'-2',digest:'sha256:'+hash(bytes[role]),size_in_bytes:bytes[role].length,expired:false,workflow_run:{id:123,head_sha:source.commit},created_at:'2026-10-18T00:01:00Z'}));
    let mode='good', downloads=0;
    const diagnostics=[];
    mock.method(console,'error',line=>{if(typeof line==='string' && line.startsWith('release-phase '))diagnostics.push(JSON.parse(line.slice('release-phase '.length)));});
    mock.module('./release/github.mjs',{namedExports:{...github,github:async()=>({...workflow,...(mode==='source'?{head_sha:'f'.repeat(40)}:{})}),attemptJobs:async()=>mode==='application'?jobs.slice(0,2):jobs,runArtifacts:async()=>artifacts.map((item,index)=>index===0?{...item,...(mode==='digest'?{digest:'sha256:'+'f'.repeat(64)}:{}),...(mode==='size'?{size_in_bytes:item.size_in_bytes-1}:{}),...(mode==='expired'?{expired:true}:{}),...(mode==='created'?{created_at:'2026-10-17T00:00:00Z'}:{})}:item)}});
    globalThis.fetch=async url=>{
      downloads++;
      const value=url.includes('/artifacts/1/')?bytes.build:bytes.scan;
      return {ok:true,status:200,arrayBuffer(){throw new Error('unbounded download forbidden')},body:new ReadableStream({start(controller){for(let offset=0;offset<value.length;offset+=37)controller.enqueue(value.subarray(offset,offset+37));controller.close();}})};
    };
    process.env.GH_TOKEN='fixture';
    const {materializeProducers}=await import('./release/supply-producers.mjs');
    const root=await mkdtemp(join(tmpdir(),'supply-auth-'));
    try {
      assert.equal((await materializeProducers(source,authority,proof,join(root,'good'))).length,2);
      assert.equal(downloads,2);
      assert.deepEqual(diagnostics.map(({phase,event})=>[phase,event]),[
        ['supply.build.download','start'],['supply.build.download','complete'],
        ['supply.build.extract','start'],['supply.build.extract','complete'],
        ['supply.scan.download','start'],['supply.scan.download','complete'],
        ['supply.scan.extract','start'],['supply.scan.extract','complete'],
      ]);
      for(const [name,error] of [['digest',/transport digest/],['size',/transport exceeds/],['source',/run identity/],['application',/proof-application-scan/],['expired',/untrusted/],['created',/untrusted/]]){
        diagnostics.length=0;
        mode=name;await assert.rejects(materializeProducers(source,authority,proof,join(root,name)),error);
        if(['digest','size'].includes(name)){
          assert.equal(diagnostics.at(-1).phase,'supply.build.download');
          assert.equal(diagnostics.at(-1).event,'failed');
        }else assert.deepEqual(diagnostics,[]);
      }
    } finally {await rm(root,{recursive:true,force:true});}
  `;
  execFileSync(
    process.execPath,
    ["--experimental-test-module-mocks", "--input-type=module", "-e", script],
    { stdio: "pipe" },
  );
});

test("production publication and capsule use canonical bounded transport and native signer membership", () => {
  const publication = zip([
    {
      name: "image.json",
      content: JSON.stringify({
        source,
        authority,
        image: { reference: "controlled" },
      }),
    },
  ]).toString("base64");
  const capsule = zip(
    releaseMembers.map((name) => ({
      name,
      content: JSON.stringify({ original: name }),
    })),
  ).toString("base64");
  const script = `
    import { mock } from 'node:test';
    import assert from 'node:assert/strict';
    import { mkdtemp,rm,readFile } from 'node:fs/promises';
    import { join } from 'node:path';
    import { tmpdir } from 'node:os';
    import * as github from './release/github.mjs';
    import { hash } from './release/supply-internal.mjs';
    const source=${JSON.stringify(source)},authority=${JSON.stringify(authority)};
    const bytes=[Buffer.from(${JSON.stringify(publication)},'base64'),Buffer.from(${JSON.stringify(capsule)},'base64')];
    const workflow={id:123,run_attempt:2,head_sha:source.commit,event:'push',path:'.github/workflows/stage.yml',head_branch:'main',repository:{id:1412858535,owner:{id:31512984}}};
    const jobs=['publish','sign'].map((name,i)=>({id:10+i,name,head_sha:source.commit,run_id:123,run_attempt:2,status:'completed',conclusion:'success',html_url:'https://github.com/ShiosOS/Damadama/actions/runs/123/job/'+(10+i),started_at:'2026-10-18T00:00:00Z',completed_at:'2026-10-18T00:02:00Z'}));
    const artifacts=['published-image-2','supply-release-2'].map((name,i)=>({id:i+1,name,digest:'sha256:'+hash(bytes[i]),size_in_bytes:bytes[i].length,expired:false,workflow_run:{id:123,head_sha:source.commit},created_at:'2026-10-18T00:01:00Z'}));
    let mode='good', jobsReads=0, artifactReads=0, zipReads=0;
    const diagnostics=[];
    mock.method(console,'error',line=>{if(typeof line==='string' && line.startsWith('release-phase '))diagnostics.push(JSON.parse(line.slice('release-phase '.length)));});
    mock.module('./release/github.mjs',{namedExports:{...github,
      github:async()=>mode==='run'?{...workflow,run_attempt:3}:workflow,
      attemptJobs:async()=>{jobsReads++; return jobs.map(j=>mode==='job'||(mode==='publish-invalid'&&j.name==='publish')?{...j,conclusion:'failure'}:j);},
      runArtifacts:async()=>{artifactReads++; return artifacts.map(a=>({...a,...(mode==='name'?{name:a.name+'x'}:{}),...(mode==='digest'?{digest:'sha256:'+'f'.repeat(64)}:{}),...(mode==='size'?{size_in_bytes:a.size_in_bytes-1}:{}),...(mode==='interval'?{created_at:'2026-10-17T00:00:00Z'}:{})}));},
    }});
    globalThis.fetch=async url=>{zipReads++; return new Response(bytes[Number(url.split('/').at(-2))-1]);};
    process.env.GH_TOKEN='synthetic';
    const {materializePublication,materializeRelease}=await import('./release/supply-producers.mjs');
    const root=await mkdtemp(join(tmpdir(),'production-artifact-'));
    try{
      assert.deepEqual((await materializePublication(source,authority,join(root,'publication'))).source,source);
      const identity=await materializeRelease(source,authority,join(root,'release'));
      assert.deepEqual(identity.signer,{id:11,name:'sign'});
      assert.equal(identity.artifact.name,'supply-release-2');
      assert.equal(JSON.parse(await readFile(join(root,'release/manifest.json'),'utf8')).original,'manifest.json');
      assert.deepEqual(diagnostics.map(({phase,event})=>[phase,event]),[
        ['supply.publication.download','start'],['supply.publication.download','complete'],
        ['supply.publication.extract','start'],['supply.publication.extract','complete'],
        ['supply.capsule.download','start'],['supply.capsule.download','complete'],
        ['supply.capsule.extract','start'],['supply.capsule.extract','complete'],
      ]);
      mode='publish-invalid';
      jobsReads=0; artifactReads=0; zipReads=0; diagnostics.length=0;
      await assert.rejects(
        materializePublication(source,authority,join(root,'invalid-publication')),
        {message:'CI publish must succeed in the exact main workflow attempt: conclusion_not_success'},
      );
      assert.equal(jobsReads,1);
      assert.equal(artifactReads,0);
      assert.equal(zipReads,0);
      assert.deepEqual(diagnostics,[]);
      for(const [change,error] of [['run',/run identity/],['job',/CI/],['name',/artifact/],['digest',/transport digest/],['size',/transport exceeds/],['interval',/untrusted/]]){
        diagnostics.length=0;
        mode=change;
        await assert.rejects(materializeRelease(source,authority,join(root,change)),error);
        if(['digest','size'].includes(change)){
          assert.equal(diagnostics.at(-1).phase,'supply.capsule.download');
          assert.equal(diagnostics.at(-1).event,'failed');
        }else assert.deepEqual(diagnostics,[]);
      }
    }finally{await rm(root,{recursive:true,force:true});}
  `;
  execFileSync(
    process.execPath,
    ["--experimental-test-module-mocks", "--input-type=module", "-e", script],
    { stdio: "pipe" },
  );
});
