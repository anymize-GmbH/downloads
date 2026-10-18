import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { APP, HELPER, REPOSITORY, PHRASE, SECOND_PHRASE, strictJson, inputIdentity, validateBuildInfo, validateAsset, fetchInput, fixturePdf, inspectSavedPdf, pngCrc, decodePng, pdfMarkers, uiNodes, selectNode, validateNativeSignIn, validateInstalledPackage, launcherComponent, validateLauncherStart, installedApkPath, signingCertificate, validateFixtureBadging, buildFixture, validateNativeEdges, assertRuntimeHealthy, runSmoke } from './android-app-smoke.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const apk = Buffer.alloc(1024 * 1024, 23); apk.set([80,75,3,4]);
const info = { schemaVersion: 1, distribution: 'sideload-preview-only', signing: 'public-expo-template-debug-certificate', variant: 'release', embeddedJavaScript: true, applicationId: APP, versionCode: 2, versionName: '0.2.0', apk: 'anymize-preview-debug-signed.apk', apkBytes: apk.length, apkSha256: hash(apk), signingCertificateSha256: 'a'.repeat(64), supportedAbis: ['arm64-v8a','x86_64'], minSdk: 24, targetSdk: 36, sourceCommit: 'b'.repeat(40), runId: '12345' };
const raw = Buffer.from(JSON.stringify(info));
const env = { GITHUB_REPOSITORY: REPOSITORY, APK_ASSET_ID: '123', APK_SHA256: info.apkSha256, BUILD_INFO_ASSET_ID: '124', BUILD_INFO_SHA256: hash(raw), APP_SOURCE_COMMIT: info.sourceCommit, GH_TOKEN: 'synthetic-test-token' };
const asset = (id, name, bytes) => ({ id: Number(id), name, size: bytes.length, state: 'uploaded', digest: `sha256:${hash(bytes)}`, url: `https://api.github.com/repos/${REPOSITORY}/releases/assets/${id}` });

test('strict JSON rejects duplicate nested keys and malformed or oversized input', () => {
  assert.deepEqual(strictJson('{"a":[{"b":"quoted \\\" text"}],"c":true}'), { a: [{b:'quoted " text'}], c:true });
  for (const text of ['{"a":1,"a":2}', '{"nested":{"x":1,"x":2}}', '{"a":1,"\\u0061":2}', '[] trailing', JSON.stringify({large:'x'.repeat(1024*1024)})]) assert.throws(() => strictJson(text));
});

test('input identity is limited to exact own repository, hashes and distinct numeric assets', () => {
  assert.equal(inputIdentity(env).sourceCommit, info.sourceCommit);
  for (const patch of [{GITHUB_REPOSITORY:'fork/downloads'}, {APK_ASSET_ID:'123?foo'}, {APK_ASSET_ID:'0'}, {APK_ASSET_ID:'https://evil.test/x'}, {BUILD_INFO_ASSET_ID:'123'}, {APK_SHA256:'A'.repeat(64)}, {APP_SOURCE_COMMIT:'b'.repeat(39)}]) assert.throws(() => inputIdentity({...env,...patch}));
});

test('raw metadata hash is checked before parsing and binds all APK release identities', () => {
  assert.equal(validateBuildInfo(raw,inputIdentity(env)).applicationId,APP);
  assert.throws(() => validateBuildInfo(Buffer.from('{malformed'),inputIdentity(env)),/hash differs/);
  for (const patch of [{applicationId:'other.app'}, {variant:'debug'}, {embeddedJavaScript:false}, {sourceCommit:'c'.repeat(40)}, {apk:'../other.apk'}, {apkSha256:'c'.repeat(64)}, {apkBytes:512*1024**2+1}, {versionCode:0}, {versionName:'<script>'}, {targetSdk:35}, {minSdk:36}, {supportedAbis:['arm64-v8a']}, {signingCertificateSha256:'x'.repeat(64)}, {runId:null}, {distribution:'reverified-sideload-preview-only'}]) {
    const bytes=Buffer.from(JSON.stringify({...info,...patch})); assert.throws(() => validateBuildInfo(bytes,{...inputIdentity(env),metadataSha256:hash(bytes)}));
  }
});

test('hash-bound expanded native alignment metadata fits the collector 1 MiB bound but cannot exceed it', () => {
  const bytes=Buffer.from(JSON.stringify({...info,pageAlignment:{syntheticExpandedProof:'x'.repeat(400*1024)}}));
  assert.ok(bytes.length>262144 && bytes.length<1024*1024);
  assert.equal(validateBuildInfo(bytes,{...inputIdentity(env),metadataSha256:hash(bytes)}).applicationId,APP);
  const tooLarge=Buffer.from(JSON.stringify({...info,pageAlignment:{syntheticExpandedProof:'x'.repeat(1024*1024)}}));
  assert.throws(()=>validateBuildInfo(tooLarge,{...inputIdentity(env),metadataSha256:hash(tooLarge)}),/exceeds 1 MiB/);
});

test('asset metadata rejects arbitrary URLs, altered state, names, bytes and checksums', () => {
  const selected=asset('123',info.apk,apk); const expected={id:'123',name:info.apk,size:apk.length,digest:hash(apk)};
  assert.equal(validateAsset(selected,expected),selected);
  for (const patch of [{id:125}, {url:'https://evil.test/x'}, {name:'other.apk'}, {state:'new'}, {size:apk.length-1}, {digest:'sha256:'+'f'.repeat(64)}]) assert.throws(() => validateAsset({...selected,...patch},expected));
});

test('fetch accepts only four exact fixed API calls and persists original verified bytes', () => {
  const root=mkdtempSync(join(tmpdir(),'anymize-smoke-input-')); const calls=[];
  try {
    const execute=(file,args) => {
      calls.push([file,args]); assert.equal(file,'gh'); assert.equal(args[0],'api');
      const id=args.at(-1).split('/').at(-1); const binary=args.includes('Accept: application/octet-stream');
      assert.equal(args.at(-1),`repos/${REPOSITORY}/releases/assets/${id}`);
      if(id==='124')return binary?raw:Buffer.from(JSON.stringify(asset(id,'build-info.json',raw)));
      if(id==='123')return binary?apk:Buffer.from(JSON.stringify(asset(id,info.apk,apk)));
      assert.fail('Unexpected asset call');
    };
    assert.equal(fetchInput({env,root,execute}).info.sourceCommit,info.sourceCommit);
    assert.equal(calls.length,4); assert.deepEqual(readFileSync(join(root,info.apk)),apk); assert.deepEqual(readFileSync(join(root,'build-info.json')),raw);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('tampered metadata fails before requesting any APK bytes', () => {
  const root=mkdtempSync(join(tmpdir(),'anymize-smoke-tamper-')); let calls=0;
  try { assert.throws(() => fetchInput({env,root,execute:()=>{calls++;return Buffer.from('{"signingCertificateSha256":"attacker"}');}}),/hash differs/); assert.equal(calls,1); }
  finally {rmSync(root,{recursive:true,force:true});}
});

test('synthetic PDF has correct xref byte offsets, one page and known text', () => {
  const pdf=fixturePdf(); const text=pdf.toString('ascii'); assert.ok(text.includes(PHRASE));
  assert.equal([...text.matchAll(/\/Type \/Page\b/g)].length,1);
  const start=Number(/startxref\n(\d+)\n%%EOF/.exec(text)[1]); assert.equal(text.slice(start,start+4),'xref');
  const rows=[...text.matchAll(/^(\d{10}) 00000 n $/gm)]; assert.equal(rows.length,5);
  rows.forEach((row,index)=>assert.equal(text.slice(Number(row[1]),Number(row[1])+7),`${index+1} 0 obj`));
  assert.throws(()=>inspectSavedPdf(pdf),/new bounded PDF/);
  assert.ok(fixturePdf(SECOND_PHRASE).includes(Buffer.from(SECOND_PHRASE)));assert.ok(!fixturePdf(SECOND_PHRASE).equals(pdf));assert.throws(()=>fixturePdf('arbitrary input'));
});

function rotatedPdf(compressed=false) {
  const text=fixturePdf().toString('ascii').replace('/MediaBox [0 0 300 200]','/Rotate 90 /MediaBox [0 0 300 200]');
  if(!compressed)return Buffer.from(text);
  const expanded=Buffer.from(`/Type /Page /Rotate 90 /Contents (${PHRASE})`); const compressedBytes=deflateSync(expanded);
  return Buffer.concat([Buffer.from('%PDF-1.7\n'+' '.repeat(520)+`\n1 0 obj\n<< /Type /ObjStm /Filter /FlateDecode /Length ${compressedBytes.length} >>\nstream\n`),compressedBytes,Buffer.from('\nendstream\nendobj\n%%EOF\n')]);
}

test('saved PDF inspection checks original marker and actual rotation, including object streams', () => {
  for(const compressed of [false,true])assert.equal(inspectSavedPdf(rotatedPdf(compressed)).rotation,90);
  for(const bytes of [Buffer.alloc(1000),Buffer.from(rotatedPdf().toString().replace('Rotate 90','Rotate 180')),Buffer.from(rotatedPdf().toString().replace(PHRASE,'OTHER_TEXT_731')),Buffer.from(rotatedPdf().toString().replace('%%EOF','broken'))])assert.throws(()=>inspectSavedPdf(bytes));
});

const chunk=(type,data)=>{const name=Buffer.from(type);const length=Buffer.alloc(4);length.writeUInt32BE(data.length);const crc=Buffer.alloc(4);crc.writeUInt32BE(pngCrc(Buffer.concat([name,data])));return Buffer.concat([length,name,data,crc]);};
function syntheticPng({vertical=false,blank=false,filter=0,channels=4}={}) {
  const width=300,height=500,stride=width*channels;const pixels=Buffer.alloc(width*height*channels,255);
  if(!blank)for(const [x,y,color] of [[80,120,[255,8,25]],[vertical?80:180,vertical?250:120,[13,33,255]]])for(let dy=0;dy<20;dy++)for(let dx=0;dx<20;dx++)pixels.set(color,((y+dy)*width+x+dx)*channels);
  const raw=Buffer.alloc((stride+1)*height);
  for(let y=0;y<height;y++){raw[y*(stride+1)]=filter;for(let x=0;x<stride;x++){
    const i=y*stride+x;const left=x>=channels?pixels[i-channels]:0,up=y?pixels[i-stride]:0,upperLeft=y&&x>=channels?pixels[i-stride-channels]:0;let predictor=0;
    if(filter===1)predictor=left;else if(filter===2)predictor=up;else if(filter===3)predictor=Math.floor((left+up)/2);else if(filter===4){const p=left+up-upperLeft,a=Math.abs(p-left),b=Math.abs(p-up),c=Math.abs(p-upperLeft);predictor=a<=b&&a<=c?left:b<=c?up:upperLeft;}
    raw[y*(stride+1)+1+x]=(pixels[i]-predictor)&255;
  }}
  const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=channels===4?6:2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}

test('independent screenshot decoder reconstructs all five PNG filters and RGB/RGBA', () => {
  for(const channels of [3,4])for(let filter=0;filter<5;filter++){
    const decoded=decodePng(syntheticPng({filter,channels}));assert.equal(decoded.width,300);assert.equal(decoded.height,500);assert.equal(decoded.channels,channels);assert.deepEqual([...decoded.pixels.subarray((120*300+80)*channels,(120*300+80)*channels+3)],[255,8,25]);
  }
});

test('real pixel oracle requires both color markers and a genuine changed orientation', () => {
  assert.equal(pdfMarkers(syntheticPng(),'horizontal').red.count,400);
  assert.equal(pdfMarkers(syntheticPng({vertical:true}),'vertical').blue.count,400);
  assert.throws(()=>pdfMarkers(syntheticPng(),'vertical'),/rotation/);
  assert.throws(()=>pdfMarkers(syntheticPng({vertical:true}),'horizontal'),/rotation/);
  assert.throws(()=>pdfMarkers(syntheticPng({blank:true}),'horizontal'),/markers/);
  assert.throws(()=>pdfMarkers(syntheticPng(),'anything'));
});

test('pixel decoder rejects screenshot assertions, missing end, corrupt CRC and impossible dimensions', () => {
  const png=syntheticPng();const corrupt=Buffer.from(png);corrupt[40]^=1;
  const invalidHeader=Buffer.alloc(13);invalidHeader.writeUInt32BE(100000,0);invalidHeader.writeUInt32BE(500,4);invalidHeader[8]=8;invalidHeader[9]=6;
  for(const bytes of [Buffer.from('Assertion failed: renderer crashed'),png.subarray(0,png.length-12),corrupt,Buffer.concat([png,Buffer.from('extra')]),Buffer.concat([png.subarray(0,8),chunk('IHDR',invalidHeader),png.subarray(33)])])assert.throws(()=>decodePng(bytes));
});

const xmlNode=(props={})=>`<node text="Find text" content-desc="" package="${APP}" class="android.widget.EditText" enabled="true" clickable="true" bounds="[10,20][200,80]" ${Object.entries(props).map(([key,value])=>`${key}="${value}"`).join(' ')}/>`;
const hierarchy=(nodes)=>`<?xml version="1.0"?><hierarchy rotation="0">${nodes}</hierarchy>`;

test('UI parser decodes XML labels and selector requires same enabled visible app node', () => {
  const nodes=uiNodes(hierarchy(xmlNode()));assert.deepEqual(selectNode(nodes,'Find text',{editable:true}).rect,[10,20,200,80]);
  const escaped=uiNodes(hierarchy(xmlNode().replace('Find text','PDF &amp; &#x41; &#66;')));assert.equal(escaped[0].text,'PDF & A B');
  for(const xml of [hierarchy(xmlNode().replace('enabled="true"','enabled="false"')),hierarchy(xmlNode().replace(APP,'other.app')),hierarchy(xmlNode().replace('[10,20][200,80]','[0,0][0,0]')),hierarchy(xmlNode().replace('[10,20][200,80]','[10,1400][200,1500]')),hierarchy(xmlNode().replace('android.widget.EditText','android.widget.TextView'))])assert.equal(selectNode(uiNodes(xml),'Find text',{editable:true}),null);
});

test('UI selectors reject ambiguous controls, external entities, duplicate attributes and huge XML', () => {
  assert.throws(()=>selectNode(uiNodes(hierarchy(xmlNode()+xmlNode().replace('[10,20][200,80]','[210,20][400,80]'))),'Find text'),/Ambiguous/);
  for(const xml of [hierarchy(xmlNode({'text':'other'})),'<!DOCTYPE x>'+hierarchy(xmlNode()),'<hierarchy>',' '.repeat(2*1024**2+1)])assert.throws(()=>uiNodes(xml));
});

test('native sign-in requires its actual enabled first-party control and rejects provider forms', () => {
  const button = { package: APP, text: 'Sign in with anymize', class: 'android.widget.Button', enabled: 'true', clickable: 'true', 'resource-id': 'native-sign-in-action', rect: [10,100,400,160] };
  for (const id of ['native-sign-in-action', `${APP}:id/native-sign-in-action`]) {
    const proof = validateNativeSignIn([{ ...button, 'resource-id': id }]);
    assert.equal(proof.entry, 'first-party-native'); assert.equal(proof.systemBrowserAcceptance, 'not-tested'); assert.equal(proof.authenticatedAccountAcceptance, false);
  }
  for (const patch of [{ enabled:'false' },{ clickable:'false' },{ package:'evil.app' },{ 'resource-id':'hosted-form' },{ class:'android.webkit.WebView' },{ rect:[10,100,10,160] }]) assert.throws(() => validateNativeSignIn([{ ...button, ...patch }]));
  for (const provider of [{ class:'android.widget.EditText', text:'Email' },{ class:'android.webkit.WebView', text:'' },{ text:'Continue with Google' },{ text:'Florentin' },{ text:'Password' }]) assert.throws(() => validateNativeSignIn([button,{ package:APP, ...provider }]));
  assert.throws(() => validateNativeSignIn([button,{...button,rect:[10,200,400,260]}]), /Ambiguous/);
});

test('launcher start uses an independently verified normal APK entry and rejects unresolved or timed-out launches', () => {
  assert.equal(launcherComponent(`launchable-activity: name='${APP}.MainActivity' label='anymize' icon=''\n`),`${APP}/.MainActivity`);
  for(const value of ['',`launchable-activity: name='evil.app.MainActivity'\n`,`launchable-activity: name='${APP}.MainActivity'\nlaunchable-activity: name='${APP}.Other'\n`])assert.throws(()=>launcherComponent(value));
  assert.equal(validateLauncherStart('Status: ok\nActivity: ai.anymize.mobile/.MainActivity'),'Status: ok\nActivity: ai.anymize.mobile/.MainActivity');
  for(const value of ['Status: timeout','Error: Activity not started','Status: ok\nError: unable to resolve Intent','Starting: Intent {...}'])assert.throws(()=>validateLauncherStart(value));
});

test('installed release metadata rejects mismatched version or native debug flag', () => {
  const installed='  versionCode=2 minSdk=24 targetSdk=36\n  versionName=0.2.0\n  flags=[ HAS_CODE ALLOW_CLEAR_USER_DATA ]';
  validateInstalledPackage(installed,info);
  for(const text of [installed.replace('Code=2','Code=3'),installed.replace('Name=0.2.0','Name=0.1.0'),installed+'\n  flags=[ DEBUGGABLE ]',installed+'\n versionCode=2'])assert.throws(()=>validateInstalledPackage(text,info));
});

test('installed standalone path accepts Android randomized tilde directories and rejects splits or traversal', () => {
  const path='/data/app/~~A_b-C==/ai.anymize.mobile-D_ef==/base.apk'; assert.equal(installedApkPath(`package:${path}`),path);
  for(const text of [`package:${path}\npackage:/data/app/split.apk`,'package:/data/app/../base.apk','package:/sdcard/base.apk','package:/data/app/name/split_config.apk','package:/data/app/name/base.apk;evil'])assert.throws(()=>installedApkPath(text));
});

test('actual signer parser accepts old and SDK37 single signer labels with unchanged digest', () => {
  const digest='a'.repeat(64);
  for(const label of ['Signer #1','Signer:','V1 Signer:','V2 Signer:','V3.0 Signer:','V3.0 Signer #1:','Signer (minSdkVersion=24, maxSdkVersion=32)','V3.0 Signer: (minSdkVersion=24, maxSdkVersion=32)','V3.1 Signer: (minSdkVersion=33 (dev release=true), maxSdkVersion=2147483647)'])assert.equal(signingCertificate(`Number of signers: 1\n${label} certificate SHA-256 digest: ${digest}\n`),digest);
  const ranges=`Number of signers: 1\nV3.0 Signer: (minSdkVersion=24, maxSdkVersion=32) certificate SHA-256 digest: ${digest}\nV3.1 Signer: (minSdkVersion=33, maxSdkVersion=2147483647) certificate SHA-256 digest: ${digest}\nSource Stamp Signer: certificate SHA-256 digest: ${'b'.repeat(64)}\n`;
  assert.equal(signingCertificate(ranges),digest);
});

test('actual signer parser rejects multiple identities, malformed labels, invalid ranges and source stamp alone', () => {
  const valid=`Number of signers: 1\nV3.0 Signer: certificate SHA-256 digest: ${'a'.repeat(64)}\n`;
  for(const output of [valid.replace('signers: 1','signers: 2'),valid.replace('Signer:','Signer #2:'),valid.replace('V3.0 Signer:','Unknown Signer:'),valid.replace('V3.0 Signer:','V3.1 Signer: (minSdkVersion=33, maxSdkVersion=24)'),valid+`Signer #1 certificate SHA-256 digest: ${'b'.repeat(64)}`,valid.replace('V3.0 Signer:','Source Stamp Signer:'),valid.replace('SHA-256','SHA256'),valid.replace('Number of signers: 1\n','')])assert.throws(()=>signingCertificate(output));
});

test('every actual ANR or runtime fatal is a hard failure, including unrelated system ANRs', () => {
  assertRuntimeHealthy('am_proc_start','System healthy','');
  for(const [events,system,runtime] of [['am_anr: com.android.systemui','',''],['','ANR in com.android.launcher3',''],['','','FATAL EXCEPTION: main'],['','','Fatal signal 11 (SIGSEGV)'],['','',`Process: ${APP}, PID: 1234`]])assert.throws(()=>assertRuntimeHealthy(events,system,runtime));
});

test('workflow preserves exact verified OS setup, immutable inputs and safe evidence allowlist', () => {
  const workflow=readFileSync(new URL('../.github/workflows/android-app-smoke.yml',import.meta.url),'utf8');
  assert.match(workflow,/permissions:\s*\n\s*contents: read/);assert.match(workflow,/cmdline-tools-version: '15859902'/);assert.match(workflow,/--pin-command-tools/);assert.match(workflow,/node scripts\/emulator-baseline\.mjs\s*\n\s*node scripts\/android-app-smoke\.mjs --run/);
  for(const api of ['35','36','37'])assert.match(workflow,new RegExp(`api: '${api}'`));assert.match(workflow,/sdk: '37\.0'/);assert.match(workflow,/google_apis_ps16k/);assert.match(workflow,/pages: '16384'/);
  for(const bad of ['-no-boot-anim','--no-sandbox','enable-webview','NODE_AUTH_TOKEN','contents: write','artifacts/android-app-input/','fixture-build/'])assert.ok(!workflow.includes(bad));
  assert.equal([...workflow.matchAll(/GH_TOKEN:/g)].length,1);assert.match(workflow,/saved-copy\.pdf/);
});

test('push source compilation is independent, token-free and cannot start emulator jobs', () => {
  const workflow=readFileSync(new URL('../.github/workflows/android-app-smoke.yml',import.meta.url),'utf8');
  const compile=workflow.split('  source-compile:')[1].split('  app-smoke:')[0];const runtime=workflow.split('  app-smoke:')[1];
  assert.match(workflow,/push:\s*\n\s*branches: \[main\]\s*\n\s*paths:/);assert.match(compile,/permissions: \{\}/);assert.match(compile,/https:\/\/github.com\/anymize-GmbH\/downloads\.git "\$GITHUB_SHA"/);assert.match(compile,/--compile-helper/);
  for(const forbidden of ['secrets.','github.token','GH_TOKEN','inputs.','APK_ASSET_ID','emulator-runner','--fetch'])assert.ok(!compile.includes(forbidden));
  assert.match(runtime,/if: github\.event_name == 'workflow_dispatch'/);assert.match(runtime,/needs: source-compile/);
});

test('compiled helper badging requires exact package, debug-only helper and both stable SDK labels', () => {
  const badging=`package: name='${HELPER}' versionCode='1' versionName='1.0'\nminSdkVersion:'35'\ntargetSdkVersion:'35'\napplication-debuggable\n`;
  validateFixtureBadging(badging);validateFixtureBadging(badging.replace('minSdkVersion','sdkVersion'));
  for(const text of [badging.replace(HELPER,APP),badging.replace("targetSdkVersion:'35'","targetSdkVersion:'36'"),badging.replace('application-debuggable',''),badging+"sdkVersion:'35'\n"])assert.throws(()=>validateFixtureBadging(text));
});

test('compile-only adapter records real phase failures without requiring APK inputs or OS identity', () => {
  const directory=mkdtempSync(join(tmpdir(),'anymize-helper-compiler-'));
  try {
    const sdk=join(directory,'sdk');const java=join(directory,'jdk');const root=join(directory,'output');
    mkdirSync(join(sdk,'platforms','android-35'),{recursive:true});mkdirSync(join(sdk,'build-tools','37.0.0'),{recursive:true});
    writeFileSync(join(sdk,'platforms','android-35','android.jar'),'synthetic test jar');writeFileSync(join(sdk,'platforms','android-35','source.properties'),'AndroidVersion.ApiLevel=35\n');writeFileSync(join(sdk,'build-tools','37.0.0','source.properties'),'Pkg.Revision=37.0.0\n');
    const compileEnv={GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',RUNNER_OS:'Linux',GITHUB_REPOSITORY:REPOSITORY,GITHUB_SHA:'d'.repeat(40),GITHUB_RUN_ID:'78901',ANDROID_HOME:sdk,JAVA_HOME:java};
    let commands=0;
    assert.throws(()=>buildFixture({env:compileEnv,output:root,execute:(file,args)=>{commands++;if(args[0]==='-version')return Buffer.from('javac 17.0.16\n');throw new Error('Synthetic compiler failure control');}}),/Synthetic compiler failure/);
    assert.equal(commands,2);const failure=JSON.parse(readFileSync(join(root,'helper-compile-failure.json'),'utf8'));assert.equal(failure.status,'failed');assert.equal(failure.phase,'javac');assert.equal(failure.commit,compileEnv.GITHUB_SHA);assert.equal(failure.commands.length,1);
    assert.equal(JSON.parse(JSON.stringify(compileEnv)).APK_ASSET_ID,undefined);
  } finally{rmSync(directory,{recursive:true,force:true});}
});

test('public helper exposes only a read-only granted synthetic provider and no production test hooks', () => {
  const folder=new URL('./android-app-smoke-fixtures/',import.meta.url);
  const manifest=readFileSync(new URL('AndroidManifest.xml',folder),'utf8');const provider=readFileSync(new URL('FixtureProvider.java',folder),'utf8');const grant=readFileSync(new URL('GrantActivity.java',folder),'utf8');
  assert.match(manifest,/<provider[^>]*android:exported="false"[^>]*android:grantUriPermissions="true"/);assert.match(manifest,/android:testOnly="true"/);assert.ok(!manifest.includes('uses-permission'));
  assert.match(provider,/if \(!"r"\.equals\(mode\)\)/);assert.match(provider,/"\/original"\.equals/);assert.match(provider,/"\/saved"\.equals/);assert.match(provider,/MODE_READ_ONLY/);
  assert.match(grant,/FLAG_GRANT_READ_URI_PERMISSION/);assert.match(grant,/setClipData/);assert.match(grant,/setPackage\("ai.anymize.mobile"\)/);
  assert.match(provider,/CancellationSignal signal/);assert.match(provider,/signal\.throwIfCanceled\(\)/);assert.match(provider,/SystemClock\.elapsedRealtime\(\) \+ 60000/);assert.match(provider,/"\/stall"\.equals/);assert.match(provider,/fixture-second\.pdf/);
  for(const content of [manifest,provider,grant])for(const bad of ['INTERNET','http://app.','https://','setWebContentsDebuggingEnabled','FileProvider.getUriForFile','@nucleo','cookie','access_token'])assert.ok(!content.includes(bad));
});

test('native edge receipt requires exactly two ordered cases, stable foreground B and a genuine bounded idle timeout',()=>{
  const value={schemaVersion:1,status:'passed',scope:'real-granted-provider-and-intent-lifecycle-only',apkSha256:env.APK_SHA256,appSourceCommit:env.APP_SOURCE_COMMIT,cases:[{id:'cold-a-warm-b-foreground',status:'passed',coldPid:'1234',foregroundPid:'1234',activeFile:'anymize-smoke-second.pdf',activePhrase:SECOND_PHRASE,hubOriginalCount:1,hubSecondCount:1},{id:'stalled-provider-preserves-b-and-recovers',status:'passed',noticeAfterMs:31000,priorFile:'anymize-smoke-second.pdf',priorPhrase:SECOND_PHRASE,priorPdfRetained:true,recoveryFile:'anymize-smoke-fixture.pdf',recoveryPhrase:PHRASE}]};
  validateNativeEdges(value,inputIdentity(env));
  for(const mutate of [(x)=>x.cases.reverse(),(x)=>x.cases.push(x.cases[0]),(x)=>{x.cases[0].hubOriginalCount=2;},(x)=>{x.cases[0].foregroundPid='9999';},(x)=>{x.cases[0].activePhrase=PHRASE;},(x)=>{x.cases[1].noticeAfterMs=1000;},(x)=>{x.cases[1].noticeAfterMs=45001;},(x)=>{x.cases[1].priorPdfRetained=false;},(x)=>{x.cases[1].recoveryPhrase=SECOND_PHRASE;}]){const copy=structuredClone(value);mutate(copy);assert.throws(()=>validateNativeEdges(copy,inputIdentity(env)));}
});

function simulatedDevice({ anrAfterRotate=false, wrongInstalledApk=false, replayAOnForeground=false, stallNoticeAfterMs=30000, rejectRecovery=false, embeddedProvider=false }={}) {
  const directory=mkdtempSync(join(tmpdir(),'anymize-smoke-orchestrator-')); const input=join(directory,'input');const root=join(directory,'output');const baselineRoot=join(directory,'baseline');
  mkdirSync(input);mkdirSync(baselineRoot);writeFileSync(join(input,info.apk),apk);writeFileSync(join(input,'build-info.json'),raw);
  const runtimeEnv={...env,GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',RUNNER_OS:'Linux',GITHUB_SHA:'c'.repeat(40),GITHUB_RUN_ID:'56789',GITHUB_RUN_ATTEMPT:'1',EXPECTED_API:'37',EXPECTED_PAGE_SIZE:'16384',EXPECTED_IMAGE:'google_apis_ps16k',ANDROID_HOME:'/synthetic-sdk'};
  writeFileSync(join(baselineRoot,'result.json'),JSON.stringify({status:'passed',scope:'real-emulator-os-only-no-app-acceptance',commit:runtimeEnv.GITHUB_SHA,runId:runtimeEnv.GITHUB_RUN_ID,api:'37',pageSize:'16384'}));
  const model={mode:'hub',rotated:false,searched:false,query:'',kind:'original',documents:new Set(),stalledAt:null,stalledOnce:false,forceStops:0,relaunched:false,running:true,offlineReads:0,clock:1700000000000,controls:new Map(),calls:[],grantWhileOffline:0};
  const filename=()=>model.kind==='saved'?'anymize-smoke-saved.pdf':model.kind==='second'?'anymize-smoke-second.pdf':'anymize-smoke-fixture.pdf';
  const pngHorizontal=syntheticPng(),pngVertical=syntheticPng({vertical:true}),blank=syntheticPng({blank:true});
  const tree=()=>{
    model.controls.clear();let index=0;
    const node=(label,{edit=false,packageName=APP}={})=>{
      const y=20+index++*60;model.controls.set(`110,${y+20}`,label);
      return `<node text="${label}" content-desc="" resource-id="${label==='Sign in with anymize'?'native-sign-in-action':''}" package="${packageName}" class="android.widget.${edit?'EditText':'Button'}" enabled="true" clickable="true" bounds="[10,${y}][210,${y+40}]"/>`;
    };
    if(model.mode==='hub')return hierarchy(node('Your workspace')+node('Chat')+[...model.documents].map((name)=>node(name)).join(''));
    if(model.mode==='auth')return hierarchy(node('Sign in with anymize')+(embeddedProvider?node('Email address',{edit:true})+node('Continue with Google'):''));
    if(model.mode==='picker')return hierarchy(node('Downloads',{packageName:'com.android.documentsui'})+node('Save',{packageName:'com.android.documentsui'}));
    return hierarchy(node(filename())+node(model.rotated?'Unsaved changes':'Unchanged file')+node('Find text',{edit:true})+node('Rotate page')+node('Save a copy')+node('Workspace')+(model.searched?node(`Page 1: ${model.query} synthetic local PDF`):'')+(model.mode==='saved'?node('Copy saved'):'')+(model.stalledAt!==null&&model.clock-model.stalledAt>=stallNoticeAfterMs?node('This PDF could not be opened. Choose a local PDF.'):''));
  };
  const execute=(file,args)=>{
    model.clock+=20;model.calls.push([file,[...args]]);
    if(file.endsWith('apksigner'))return Buffer.from(`Number of signers: 1\nV3.0 Signer: certificate SHA-256 digest: ${info.signingCertificateSha256}\n`);
    if(file.endsWith('aapt2'))return Buffer.from(`package: name='${APP}' versionCode='2' versionName='0.2.0'\nlaunchable-activity: name='${APP}.MainActivity' label='anymize' icon=''\n`);
    assert.equal(file,'adb');assert.deepEqual(args.slice(0,2),['-s','emulator-5554']);const call=args.slice(2);
    if(call[0]==='install')return Buffer.from('Success');
    if(call[0]==='exec-out')return model.mode==='viewer'||model.mode==='saved'?model.rotated?pngVertical:pngHorizontal:blank;
    if(call[0]==='pull'){writeFileSync(call[2],call[1].endsWith('base.apk')?(wrongInstalledApk?Buffer.alloc(apk.length):apk):rotatedPdf());return Buffer.from('1 file pulled');}
    if(call[0]==='push')return Buffer.from('1 file pushed');
    assert.equal(call[0],'shell');const cmd=call.slice(1);const joined=cmd.join(' ');
    if(cmd[0]==='logcat')return Buffer.from(anrAfterRotate&&model.rotated&&cmd.includes('events')?'am_anr: com.android.systemui':'');
    if(joined===`dumpsys package ${APP}`)return Buffer.from(' versionCode=2 minSdk=24 targetSdk=36\n versionName=0.2.0\n flags=[ HAS_CODE ]');
    if(joined===`pm list packages -U ${APP}`)return Buffer.from(`package:${APP} uid:10123`);
    if(joined===`pm path ${APP}`)return Buffer.from(`package:/data/app/~~A_b==/${APP}-C_D==/base.apk`);
    if(joined==='dumpsys activity activities')return Buffer.from(`mResumedActivity: ActivityRecord{${APP}/.MainActivity}`);
    if(joined===`pidof ${APP}`)return Buffer.from(model.forceStops>=2?'6543':model.relaunched?'5432':'4321');
    if(joined==='cat /proc/net/unix')return Buffer.from('Num RefCount Protocol Flags Type St Inode Path');
    if(cmd[0]==='svc')return Buffer.from('');
    if(joined==='dumpsys connectivity')return Buffer.from(++model.offlineReads===1?'Active default network: 123':'Active default network: none');
    if(joined==='dumpsys input_method')return Buffer.from('mInputShown=false');
    if(cmd[0]==='uiautomator')return Buffer.from('UI hierarchy dumped');
    if(joined==='cat /sdcard/anymize-app-smoke.xml')return Buffer.from(tree());
    if(cmd[0]==='am'&&cmd[1]==='force-stop'){model.running=false;model.forceStops++;model.documents.clear();model.query='';model.searched=false;return Buffer.from('');}
    if(cmd[0]==='ps')return Buffer.from(model.running?`PID NAME\n4321 ${APP}`:'PID NAME\n555 ai.anymize.smokefixture');
    if(cmd[0]==='am'&&cmd[1]==='start'){
      if(cmd.includes('android.intent.action.MAIN')){assert.ok(cmd.includes('-n'));assert.equal(cmd.at(-1),`${APP}/.MainActivity`);assert.ok(!cmd.includes('-p'));}
      if(cmd.includes('fixture')){
        assert.ok(model.offlineReads>=2);model.grantWhileOffline++;const kind=cmd.at(-1);
        if(kind==='stall'){model.stalledAt=model.clock;model.stalledOnce=true;}
        else if(!(rejectRecovery&&model.stalledOnce&&kind==='original')){model.mode='viewer';model.running=true;model.kind=kind;model.rotated=kind==='saved';model.searched=false;model.stalledAt=null;if(kind==='saved')model.relaunched=true;model.documents.add(filename());}
      }else if(replayAOnForeground&&model.forceStops>=2){model.kind='original';model.searched=false;model.query='';}
      return Buffer.from('Status: ok');
    }
    if(cmd[0]==='input'){
      if(cmd[1]==='tap'){
        const label=model.controls.get(`${cmd[2]},${cmd[3]}`);assert.ok(label,`Unexpected tap ${joined}`);
        if(label==='Rotate page')model.rotated=true;else if(label==='Save a copy')model.mode='picker';else if(label==='Save')model.mode='saved';else if(label==='Workspace')model.mode='hub';else if(label==='Chat')model.mode='auth';else if(label==='anymize-smoke-second.pdf'){model.kind='second';model.mode='viewer';model.rotated=false;model.searched=false;}
      }else if(cmd[1]==='text')model.query=cmd[2];else if(cmd[1]==='keyevent'&&cmd.includes('KEYCODE_DEL')){model.query='';model.searched=false;}else if(cmd[1]==='keyevent'&&cmd.includes('KEYCODE_ENTER'))model.searched=true;
      return Buffer.from('');
    }
    if(['rm','chmod','run-as'].includes(cmd[0]))return Buffer.from('');
    assert.fail(`Unexpected command: ${joined}`);
  };
  return {directory,root,model,options:{env:runtimeEnv,input,root,baselineRoot,execute,now:()=>model.clock,pause:async(ms)=>{model.clock+=ms;},output:()=>{}}};
}

test('orchestration simulation covers delayed offline state, genuine picker package, installed bytes and fresh relaunch', async () => {
  const simulation=simulatedDevice();
  try {
    const result=await runSmoke(simulation.options);
    assert.equal(result.status,'passed');assert.equal(result.authenticatedAccountAcceptance,false);assert.equal(result.offlinePdf,true);
    assert.equal(result.initialPid,'4321');assert.equal(result.relaunchedPid,'5432');assert.equal(result.appSourceCommit,info.sourceCommit);assert.equal(result.pageSize,'16384');
    assert.equal(simulation.model.offlineReads,2);assert.equal(simulation.model.grantWhileOffline,6);assert.equal(result.stages.length,8);assert.ok(result.stages.every((stage)=>!stage.name.startsWith('native-edge')));
    assert.deepEqual(result.stages.map((stage)=>stage.name),['01-local-hub','02-original-pdf','03-search-match','04-rotated-pdf','05-save-picker','06-saved-notice','07-relaunched-saved-pdf','08-native-sign-in-entry']);
    assert.equal(result.scope,'real-current-apk-local-pdf-and-native-sign-in-entry-only');assert.equal(result.nativeSignInEntry.embeddedProviderForm,false);
    const edges=JSON.parse(readFileSync(join(simulation.root,'native-edge-result.json'),'utf8'));validateNativeEdges(edges,inputIdentity(env));assert.equal(edges.cases.length,2);assert.equal(edges.cases[1].noticeAfterMs>=30000,true);
    assert.ok(result.files.some((file)=>file.name==='saved-copy.pdf'&&file.sha256===hash(rotatedPdf())));
    for(const file of result.files){const bytes=readFileSync(join(simulation.root,file.name));assert.equal(bytes.length,file.bytes);assert.equal(hash(bytes),file.sha256);}
    assert.ok(!simulation.model.calls.some(([,args])=>args.includes('logcat')&&args.includes('-c')));
  } finally{rmSync(simulation.directory,{recursive:true,force:true});}
});

test('orchestration simulation preserves an ANR failure signal before saving or relaunching', async () => {
  const simulation=simulatedDevice({anrAfterRotate:true});
  try {
    await assert.rejects(runSmoke(simulation.options),/ANR observed/);
    const failure=JSON.parse(readFileSync(join(simulation.root,'failure.json'),'utf8'));assert.equal(failure.status,'failed');assert.ok(failure.message.includes('ANR'));assert.ok(failure.files.some((file)=>file.name.startsWith('health-failure-')));assert.equal(simulation.model.grantWhileOffline,1);
    assert.ok(!simulation.model.calls.some(([,args])=>args.includes('force-stop')));
  } finally{rmSync(simulation.directory,{recursive:true,force:true});}
});

test('orchestration rejects an embedded provider form even beside a correctly labelled native action', async () => {
  const simulation=simulatedDevice({embeddedProvider:true});
  try {
    await assert.rejects(runSmoke(simulation.options), /Embedded provider credential UI/);
    const failure=JSON.parse(readFileSync(join(simulation.root,'failure.json'),'utf8'));
    assert.equal(failure.status,'failed');assert.equal(failure.stages.length,7);
    assert.ok(failure.files.some((file)=>file.name==='native-edge-result.json'));
    assert.ok(!failure.stages.some((stage)=>stage.name==='08-native-sign-in-entry'));
  } finally { rmSync(simulation.directory,{recursive:true,force:true}); }
});

test('orchestration simulation rejects substituted installed bytes before any app operation', async () => {
  const simulation=simulatedDevice({wrongInstalledApk:true});
  try {
    await assert.rejects(runSmoke(simulation.options),/Installed device APK bytes differ/);
    const failure=JSON.parse(readFileSync(join(simulation.root,'failure.json'),'utf8'));assert.equal(failure.status,'failed');assert.equal(failure.stages.length,0);assert.equal(simulation.model.grantWhileOffline,0);
  } finally{rmSync(simulation.directory,{recursive:true,force:true});}
});

test('orchestration simulation rejects the old cold A intent replay on foreground',async()=>{
  const simulation=simulatedDevice({replayAOnForeground:true});
  try{await assert.rejects(runSmoke(simulation.options),/actual enabled UI control unavailable/i);const failure=JSON.parse(readFileSync(join(simulation.root,'failure.json'),'utf8'));assert.equal(failure.status,'failed');assert.equal(failure.stages.length,7);assert.ok(!failure.files.some((file)=>file.name==='native-edge-result.json'));}finally{rmSync(simulation.directory,{recursive:true,force:true});}
});

test('orchestration simulation rejects instant provider errors and a stall beyond 45 seconds',async()=>{
  for(const delay of [0,50000]){const simulation=simulatedDevice({stallNoticeAfterMs:delay});try{await assert.rejects(runSmoke(simulation.options),delay===0?/30-second idle-timeout/:/actual enabled UI control unavailable/i);const failure=JSON.parse(readFileSync(join(simulation.root,'failure.json'),'utf8'));assert.equal(failure.status,'failed');assert.ok(!failure.files.some((file)=>file.name==='native-edge-result.json'));}finally{rmSync(simulation.directory,{recursive:true,force:true});}}
});

test('orchestration simulation rejects loss of subsequent valid provider access after the stall',async()=>{
  const simulation=simulatedDevice({rejectRecovery:true});
  try{await assert.rejects(runSmoke(simulation.options),/actual enabled UI control unavailable/i);const failure=JSON.parse(readFileSync(join(simulation.root,'failure.json'),'utf8'));assert.equal(failure.status,'failed');assert.ok(!failure.files.some((file)=>file.name==='native-edge-result.json'));}finally{rmSync(simulation.directory,{recursive:true,force:true});}
});
