import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";

test("production issuance and admission compose original validation and fresh receipts with controlled boundaries", () => {
  const script = `
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';
    import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    const internal = await import('./release/supply-internal.mjs');
    const { buildRoles, scanRoles, signerRoles } = await import('./release/supply-evidence.mjs');
    const source={repository:'ShiosOS/Damadama',commit:'a'.repeat(40),tree:'b'.repeat(40)};
    const authority={sha:source.commit,runId:42,attempt:2};
    const candidate={schema:2,source,authority};
    const image={reference:'ghcr.io/shiosos/damadama@sha256:'+'c'.repeat(64),digest:'sha256:'+'c'.repeat(64),archiveSha256:internal.hash('image.tar'),version:'main-aaaaaaaaaaaa'};
    const identity={artifact:{id:90,name:'supply-release-2',digest:'sha256:'+'d'.repeat(64),size:100},signer:{id:80,name:'sign'}};
    let mode='good', calls=[];
    const sbom={spdxVersion:'SPDX-2.3'};
    mock.module('./release/controller.mjs',{namedExports:{requireFreshCandidate:async()=>{calls.push('native'); if(mode==='native')throw Error('native refusal'); return [];}}});
    mock.module('./release/images.mjs',{namedExports:{prepareArchive:async()=>{calls.push('prepare');return{};},publishArchive:()=>{calls.push('push');return image;}}});
    mock.module('./release/supply-registry.mjs',{namedExports:{compareRegistryArchive:async()=>{calls.push('registry');if(mode==='registry')throw Error('registry refusal');}}});
    mock.module('./release/supply-producers.mjs',{namedExports:{
      materializeProducers:async(s,a,t,d)=>{assert.equal(t,internal.production);calls.push('originals');for(const [role,names] of [['build',buildRoles],['scan',scanRoles]]){await mkdir(join(d,role));for(const name of names){await mkdir(join(d,role,name,'..'),{recursive:true});await writeFile(join(d,role,name),name==='build.json'?'{}':name);}}return [{role:'build'},{role:'scan'}];},
      materializePublication:async()=>{calls.push('publication');return {source:mode==='source'?{...source,tree:'f'.repeat(40)}:source,authority,image};},
      materializeRelease:async()=>{calls.push('capsule');return mode==='capsule'?{...identity,artifact:{...identity.artifact,id:91}}:identity;},
    }});
    mock.module('./release/supply-chain.mjs',{namedExports:{
      compareOriginals:async()=>{calls.push('compare');},validateEvidence:async()=>{calls.push('validate');return{sbom};},
      verifyRelease:async(request)=>{calls.push('verify');assert.deepEqual(Object.keys(request).sort(),['evidenceDirectory','expectedAuthority','expectedImage','expectedSource']);if(mode==='refuse')throw Error('signature refusal');return{kind:mode==='forged'?'ci-signature-proof':'authenticated-release-receipt',image:mode==='image'?{...image,digest:'sha256:'+'e'.repeat(64)}:image,manifestSha256:mode==='manifest'?'e'.repeat(64):'f'.repeat(64)};},
    }});
    mock.module('./release/supply-internal.mjs',{namedExports:{...internal,verifySignature:async(subject,bundle,trust,s,a,type)=>{calls.push('signature');assert.equal(subject,'oci://'+image.reference);assert.equal(trust,internal.production);return {subject:[{name:'ghcr.io/shiosos/damadama'}],predicate:mode==='sbom'?{}:sbom};}}});
    const release=await import('./release/supply-release.mjs');
    const root=await mkdtemp(join(tmpdir(),'release-control-'));
    try {
      const located=await release.locateRelease(candidate);
      assert.deepEqual(located,{image,supply:{schema:1,...identity,manifestSha256:'f'.repeat(64)}});
      assert.equal(await release.authenticateRelease(candidate,image,located.supply),undefined);
      assert.equal(calls.filter(x=>x==='verify').length,2);
      for(const [change,error] of [['source',/publication source/],['capsule',/frozen signed/],['manifest',/frozen signed/],['image',/unexpected production/],['forged',/unexpected production/],['refuse',/signature refusal/]]){mode=change;await assert.rejects(release.authenticateRelease(candidate,image,located.supply),error);}
      mode='good';calls=[];
      await release.publishCandidate(candidate);
      assert.deepEqual(calls,['native','originals','validate','native','prepare','native','push','native','registry','native']);
      mode='native';calls=[];
      await assert.rejects(release.publishCandidate(candidate),/native refusal/);assert(!calls.includes('push'));
      mode='good';calls=[];
      const directory=join(root,'capsule');
      await release.prepareRelease(candidate,directory);
      for(const name of signerRoles)await writeFile(join(directory,'signer',name),'bundle');
      await release.assembleRelease(candidate,directory);
      const manifest=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8'));
      assert.equal(manifest.schema,2);assert.equal(manifest.purpose,'release-supply');assert.equal(Object.keys(manifest.files).length,22);
      assert(!calls.some(x=>['scan','build','database'].includes(x)));
      mode='sbom';await assert.rejects(release.assembleRelease(candidate,directory),/signed SPDX/);
      console.log('controlled publisher, issuer, fresh locator, frozen identity and SPDX refusals passed');
    }finally{await rm(root,{recursive:true,force:true});}
  `;
  const output = execFileSync(
    process.execPath,
    ["--experimental-test-module-mocks", "--input-type=module", "-e", script],
    { encoding: "utf8" },
  );
  assert.match(output, /refusals passed/);
});

test("production CLI refuses extra or missing arguments before reading candidates", () => {
  for (const args of [
    ["publish"],
    ["publish", "out", "role"],
    ["prepare", "out", "role"],
    ["assemble", "out", "role"],
    ["verify", "out", "role"],
    ["upload-paths", "out"],
    ["upload-paths", "out", "build", "extra"],
    ["unexpected", "out"],
  ]) {
    const result = spawnSync(
      process.execPath,
      ["release/supply-release.mjs", ...args],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /invalid production supply command arguments|unknown production supply command/,
    );
    assert.doesNotMatch(result.stderr, /ENOENT|candidate.json/);
  }
});
