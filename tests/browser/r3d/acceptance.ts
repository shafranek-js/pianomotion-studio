import { ALL_FORMATS, AudioBufferSink, BufferSource, EncodedPacketSink, Input, VideoSampleSink } from "mediabunny";
import { analyzeSourceCandidate } from "../../../apps/client/src/player/controller";
import { createM1AnalysisWorker } from "../../../apps/client/src/m1WorkerClient";
import { DEFAULT_PROFILE } from "../../../apps/client/src/profiles/defaultProfiles";
import { DEFAULT_SETTINGS } from "../../../apps/client/src/settings/types";
import { VideoExporter } from "../../../apps/client/src/export/videoExporter";
import type { ExportSceneDataSource } from "../../../apps/client/src/export/types";

const status = document.querySelector<HTMLPreElement>("#status")!;
const artifacts = document.querySelector<HTMLDivElement>("#artifacts")!;
const result = document.querySelector<HTMLPreElement>("#result")!;
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

function testMidi(): ArrayBuffer {
  const track = [0,0x90,48,85,0,0x90,64,90,0x83,0x60,0x80,48,0,0,0x80,64,0,
    0x83,0x60,0x90,52,90,0,0x90,67,85,0x83,0x60,0x80,52,0,0,0x80,67,0,0,0xff,0x2f,0];
  return new Uint8Array([77,84,104,100,0,0,0,6,0,0,0,1,1,224,77,84,114,107,
    0,0,0,track.length,...track]).buffer;
}

async function inspect(blob: Blob, format: string) {
  const bytes = await blob.arrayBuffer();
  const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(bytes) });
  try {
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    assert(video && audio, "Video/audio tracks are required");
    assert(video.displayWidth === 1280 && video.displayHeight === 720, "Wrong output size");
    const packets = [];
    for await (const packet of new EncodedPacketSink(video).packets()) packets.push(packet);
    assert(packets.length > 30 && packets.every(p => p.byteLength > 0), "Empty video packets");
    const ordered = [...packets].sort((a,b) => a.timestamp-b.timestamp);
    for(let i=1;i<ordered.length;i++) assert(Math.abs(ordered[i]!.timestamp-ordered[i-1]!.timestamp-1/30)<.002,"Video timestamps drifted");
    const duration = await video.computeDuration();
    const audioDuration = await audio.computeDuration();
    assert(Math.abs(duration-audioDuration)<1/30+.03,"Audio/video durations diverged");
    const sink = new VideoSampleSink(video);
    const frames: ImageData[] = [];
    const section = document.createElement("section"); artifacts.append(section);
    const caption = document.createElement("h2"); caption.textContent=format; section.append(caption);
    for(const t of [.4,1.4]) {
      const sample = await sink.getSample(t); assert(sample,"Could not decode frame");
      const canvas = document.createElement("canvas"); canvas.width=1280;canvas.height=720;
      const ctx = canvas.getContext("2d",{willReadFrequently:true})!;
      try { sample.draw(ctx,0,0); } finally { sample.close(); }
      frames.push(ctx.getImageData(0,0,1280,720)); section.append(canvas);
    }
    let changed=0,skinChanged=0,bright=0;
    const a=frames[0]!.data,b=frames[1]!.data;
    for(let i=0;i<a.length;i+=4*3) {
      if(a[i]!>140&&a[i+1]!>140&&a[i+2]!>140)bright++;
      const diff=Math.abs(a[i]!-b[i]!)+Math.abs(a[i+1]!-b[i+1]!)+Math.abs(a[i+2]!-b[i+2]!);
      if(diff>32){changed++; if((a[i]!>a[i+1]!*1.12&&a[i+1]!>a[i+2]!*1.06&&a[i]!>65)||(b[i]!>b[i+1]!*1.12&&b[i+1]!>b[i+2]!*1.06&&b[i]!>65))skinChanged++;}
    }
    assert(bright>500,"Keyboard missing from decoded frame");
    assert(changed>50&&skinChanged>10,"Decoded hands/notes did not move");
    let peakRms=0;
    for await(const wrapped of new AudioBufferSink(audio).buffers()) {
      const data=wrapped.buffer.getChannelData(0);
      peakRms=Math.max(peakRms,Math.sqrt(data.reduce((s,v)=>s+v*v,0)/data.length));
    }
    assert(peakRms>1e-5,"Decoded audio is silent");
    const link=document.createElement("a"); link.href=URL.createObjectURL(blob);link.download=`r3d-${format}.${format}`;link.textContent=`Download ${format}`;section.append(link);
    const player=document.createElement("video");player.controls=true;player.muted=true;player.src=link.href;section.append(player);
    await new Promise<void>((resolve,reject)=>{player.addEventListener("loadedmetadata",()=>resolve(),{once:true});player.addEventListener("error",()=>reject(new Error("Native playback failed")),{once:true});});
    await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("Seek timeout")),10000);player.addEventListener("seeked",()=>{clearTimeout(timer);resolve();},{once:true});player.currentTime=1.1;});
    await player.play(); await new Promise(resolve=>setTimeout(resolve,150)); player.pause();
    return { format,bytes:bytes.byteLength,width:video.displayWidth,height:video.displayHeight,duration,audioDuration,frames:packets.length,changed,skinChanged,bright,peakRms,nativeSeek:true };
  } finally { input.dispose(); }
}

document.querySelector<HTMLButtonElement>("#run")!.onclick=async()=>{
  const button=document.querySelector<HTMLButtonElement>("#run")!;button.disabled=true;
  const checks: unknown[]=[];
  try {
    const { engineVersion }=await fetch("/python-core/source_manifest.json").then(r=>r.json());
    const bytes=testMidi(); const signal=new AbortController().signal;
    const worker=createM1AnalysisWorker("typescript");
    let analyzed;
    try { analyzed=await analyzeSourceCandidate({ midiBytes:bytes,projectId:"r3d-acceptance",revision:0,engineVersion,
      sourceContext:{fixtureId:"r3d-acceptance",keyStyle:"realistic"},profile:DEFAULT_PROFILE,signal,worker,
      onProgress:message=>{status.textContent=message;} }); } finally { worker.terminate(); }
    const source: ExportSceneDataSource={document:analyzed.document!,performancePlan:analyzed.performancePlan!,motionPlan:analyzed.motionPlan,
      keyStyle:"realistic",profile:analyzed.profile,settings:{...DEFAULT_SETTINGS,calculationEngine:"typescript",leadInSeconds:-.25},
      sceneView:{dimension:"3d",cameraPreset:"concert"},sourceIdentity:{projectId:analyzed.projectId,revision:analyzed.revision,engineVersion,
        originalMidiBytes:bytes,fingeringPlan:analyzed.fingeringPlan!,rawBaseline:analyzed.rawBaseline,resource:analyzed.resource,
        sourceContext:{fixtureId:"r3d-acceptance",keyStyle:"realistic"},activeOutputId:"synth",soundFontAssetId:null}};
    for(const format of ["mp4","webm"] as const){
      const exported=await new VideoExporter().exportVideo(source,{preset:"720p",width:1280,height:720,fps:30,speed:1,format,
        includeAudio:true,audioSource:"synth",tailSeconds:.5,outputMode:"bounded-blob"},p=>{status.textContent=`${format}: ${p.statusText}`;});
      assert(exported.boundedBlob,"Missing finalized file"); checks.push(await inspect(exported.boundedBlob,format));
    }
    status.textContent="PASS: MP4 + WebM, real Worker, demux/decode, moving hands, audio, seek";
    result.textContent=JSON.stringify({passed:true,userAgent:navigator.userAgent,checks},null,2);
  }catch(error){status.textContent="FAIL";result.textContent=JSON.stringify({passed:false,error:String(error),checks},null,2);}
  finally{button.disabled=false;}
};
