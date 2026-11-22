import * as T from 'three';
import diffuse from './assets/forest-floor.webp';
import normal from './assets/forest-floor-normal.webp';

const el = (id) => document.getElementById(id);
const canvas = el('world'), stato = el('ideax-status'), start = el('ideax-start');
const regole = JSON.parse(el('regole-missione').textContent);
let renderer;
try { renderer = new T.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' }); }
catch { stato.textContent = 'WebGL 2 non disponibile in questo browser.'; throw Error(stato.textContent); }
canvas.dataset.renderer = 'webgl';
const scene = new T.Scene();
scene.background = new T.Color('#aebfa0');
scene.fog = new T.FogExp2('#9caa8d', .020);
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = T.PCFShadowMap;
renderer.outputColorSpace = T.SRGBColorSpace;
renderer.toneMapping = T.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.38;

const camera = new T.PerspectiveCamera(66, 1, .085, 130);
camera.rotation.order = 'YXZ';
scene.add(new T.HemisphereLight(0xe2e6c4, 0x3c4931, 2.15));
const sun = new T.DirectionalLight(0xffd5a1, 3.15);
sun.position.set(-24, 45, 16);
sun.target.position.set(0, 0, -5);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -34, right: 34, top: 43, bottom: -43, near: .5, far: 105 });
sun.shadow.bias = -.0004;
sun.shadow.normalBias = .035;
scene.add(sun, sun.target);

let seed = 9608;
function random() { seed = (Math.imul(seed,1664525)+1013904223)>>>0; return seed/4294967296; }
const range=(a,b)=>a+(b-a)*random();
const mat=(color, roughness=.92, metalness=0)=>new T.MeshStandardMaterial({color,roughness,metalness});
function mesh(parent, geometry, material, x, y, z, cast=true) {
  const o=new T.Mesh(geometry,material); o.position.set(x,y,z); o.castShadow=cast; o.receiveShadow=true; parent.add(o); return o;
}
const box=(p,w,h,d,m,x,y,z)=>mesh(p,new T.BoxGeometry(w,h,d),m,x,y,z);
function groundHeight(x,z) {
  const mix=Math.min(1,Math.max(0,(Math.abs(x)-4)/8));
  return mix*(Math.sin(x*.26+z*.12)*.68+Math.cos(z*.29)*.27)+Math.sin(z*.12)*.12;
}
const textureLoader=new T.TextureLoader();
function soilTexture(src, colorSpace) {
  const texture=textureLoader.load(src);
  texture.colorSpace=colorSpace;
  texture.wrapS=texture.wrapT=T.RepeatWrapping;texture.repeat.set(39,44);
  texture.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());
  return texture;
}
const landscape=new T.PlaneGeometry(92,104,88,104); landscape.rotateX(-Math.PI/2);
const coords=landscape.attributes.position, colors=[], c=new T.Color();
for(let i=0;i<coords.count;i++){
  const x=coords.getX(i),z=coords.getZ(i);
  coords.setY(i,groundHeight(x,z));
  const path=Math.abs(x)<2.55+Math.sin(z*.28)*.42 || (z < -20 && Math.abs(x)<9);
  c.set(path ? '#b7a68a' : '#76895f').multiplyScalar(range(.76,1.2));colors.push(c.r,c.g,c.b);
}
landscape.setAttribute('color',new T.Float32BufferAttribute(colors,3));landscape.computeVertexNormals();
mesh(scene,landscape,new T.MeshStandardMaterial({vertexColors:true,map:soilTexture(diffuse,T.SRGBColorSpace),
  normalMap:soilTexture(normal,T.NoColorSpace),normalScale:new T.Vector2(.58,.58),roughness:.96}),0,0,0,false);

// Vegetazione a istanze con chiome stratificate, tronchi inclinati e sottobosco.
const trunk=new T.InstancedMesh(new T.CylinderGeometry(.12,.26,1,8),mat('#524436'),190);
const crowns=new T.InstancedMesh(new T.IcosahedronGeometry(1,1),mat('#ffffff'),190*3);
const stone=new T.InstancedMesh(new T.DodecahedronGeometry(1,0),mat('#ffffff'),125);
const blades=new T.BufferGeometry(), punti=[];
for(let j=0;j<7;j++){
  const a=j*2.4,x=Math.cos(a)*.18,z=Math.sin(a)*.18,w=.035;
  punti.push(x-w,-.42,z,x+w,-.42,z,x*2,.52-j*.045,z*2);
}
blades.setAttribute('position',new T.Float32BufferAttribute(punti,3));blades.computeVertexNormals();
const grass=new T.InstancedMesh(blades,new T.MeshStandardMaterial({color:0xffffff,side:T.DoubleSide,roughness:.83}),750);
const dummy=new T.Object3D();
const ostacoli=[];
function instance(target,index,x,y,z,sx,sy,sz,ry,color){
  dummy.position.set(x,y,z);dummy.scale.set(sx,sy,sz);dummy.rotation.set(0,ry,0);dummy.updateMatrix();
  target.setMatrixAt(index,dummy.matrix);if(color)target.setColorAt(index,c.set(color));
}
for(let i=0;i<190;i++){
  let x=range(4.4,42)*(i%2?1:-1),z=range(-48,49);
  if(z<-20&&z>-34&&Math.abs(x)<13)x+=x>0?10:-10;
  const y=groundHeight(x,z), h=range(3.6,9.1), r=range(1.25,3.65);
  ostacoli.push({x,z,r:.46});
  instance(trunk,i,x,y+h*.49,z,.9,h,1,random(),null);
  for(let k=0;k<3;k++) instance(crowns,3*i+k,x+Math.cos(k*2.1)*r*.52,y+h*.83+k*.48,z+Math.sin(k*2.1)*r*.55,r,range(.65,1.45),r*.95,k,['#415f35','#526f3c','#627c46','#2f5639'][(i+k)%4]);
}
for(let i=0;i<125;i++){
  const x=range(3.7,43)*(i%2?1:-1),z=range(-44,44),s=range(.19,.89);
  instance(stone,i,x,groundHeight(x,z)+s*.23,z,s,s*.62,s*.81,range(0,6),i%2?'#756d55':'#646b5a');
}
for(let i=0;i<750;i++){
  const x=range(2.7,34)*(i%2?1:-1),z=range(-40,39),h=range(.16,.65);
  instance(grass,i,x,groundHeight(x,z)+h*.42,z,range(.5,1.3),h,1,range(0,6),['#788049','#6d8150','#a3a16b','#587344'][i%4]);
}
for(const group of [trunk,crowns,stone,grass]){group.receiveShadow=true;scene.add(group);}
trunk.castShadow=true;crowns.castShadow=true;
const ferns=new T.InstancedMesh(new T.SphereGeometry(.22,5,3),mat('#6a8956'),36*30);
let foglie=0;
for(let i=0;i<36;i++){
  const x=range(3.25,11)*(i%2?1:-1),z=range(-37,33); if(z<-20&&Math.abs(x)<8)continue;
  for(let k=0;k<6;k++){
    const a=k*Math.PI/3;
    for(let n=1;n<6;n++){
      dummy.position.set(x+Math.cos(a)*n*.105,groundHeight(x,z)+.13+n*.073,z-Math.sin(a)*n*.105);
      dummy.scale.set(.58,.09,1.08-n*.10);dummy.rotation.set(0,a,.30);dummy.updateMatrix();
      ferns.setMatrixAt(foglie++,dummy.matrix);
    }
  }
}
ferns.count=foglie; ferns.receiveShadow=true;scene.add(ferns);

// Capanno, torretta, rete e fari usano pezzi distinti per restare leggibili in prima persona.
const wood=mat('#665544'), board=mat('#8b7759'), steel=mat('#566261',.58,.28), roof=mat('#6b5240'), cement=mat('#a09c7d');
const base=new T.Group();base.position.set(0,groundHeight(0,-24),-24);scene.add(base);
box(base,10,.16,7,cement,0,.02,-3.9);
for(const side of [-1,1]){
  box(base,3.3,2.8,.19,board,side*3.18,1.45,-3.1);
  box(base,.18,2.8,4.8,wood,side*4.85,1.45,-5.45);
  for(let j=0;j<5;j++)box(base,.15,2.83,.17,wood,side*(1.55+j*.8),1.45,-2.99);
}
box(base,9.65,2.8,.15,board,0,1.45,-7.85);
for(let k=0;k<16;k++)box(base,.62,.17,5.55,k%2?roof:wood,-4.78+k*.64,3,-5.48);
for(const x of [-10,-8,-6,6,8,10]){
  box(base,.12,2.33,.12,steel,x,1.16,-.5);
  if(x!==-6&&x!==10){box(base,1.86,.06,.06,steel,x+1,1.75,-.5);box(base,1.86,.06,.06,steel,x+1,.63,-.5);}
}
const crate=new T.BoxGeometry(.82,.72,.77);
for(const [x,z] of [[-3,-1.1],[3.5,-1.3],[-4,-2.1],[3.7,-2.5],[-4,-5.4]]) {
  ostacoli.push({x,z:z-24,r:.65});
  mesh(base,crate,board,x,.38,z);box(base,.88,.075,.81,wood,x,.65,z);box(base,.88,.075,.81,wood,x,.16,z);
}
const tower=new T.Group();tower.position.set(-9,0,-2);base.add(tower);
for(const x of [-1.15,1.15])for(const z of [-1,1])box(tower,.20,4.8,.20,wood,x,2.4,z);
box(tower,2.85,.23,2.65,wood,0,4.68,0);
box(tower,3.1,.16,2.9,roof,0,6.1,0);
for(const x of [-1.2,1.2])box(tower,.13,1.45,.13,wood,x,5.42,-.82);
const glow=mat('#f8ba65');glow.emissive.set('#d98e3c');glow.emissiveIntensity=1.8;
for(const x of [-1.8,1.8])box(base,.28,.22,.19,glow,x,2.56,-2.93);
const lamp=new T.PointLight(0xffb767,18,12,1.6);lamp.position.set(0,2.5,-3.3);base.add(lamp);

const palette={cloth:mat('#53634b'),dark:mat('#313e33'),skin:mat('#a87f5e'),boot:mat('#222926'),strap:mat('#7b7252'),ally:mat('#8b8a61')};
function personnage(team){
  const p=new T.Group(), cloth=team==='ally'?palette.ally:palette.cloth;
  const hips=new T.Group();hips.position.y=.92;p.add(hips);
  mesh(hips,new T.CapsuleGeometry(.25,.27,4,10),cloth,0,.25,0);
  box(hips,.43,.33,.12,palette.strap,0,.25,-.19);
  for(const x of [-.12,0,.12])box(hips,.085,.13,.085,palette.dark,x,.20,-.27);
  box(hips,.33,.38,.18,palette.dark,0,.25,.22);
  mesh(hips,new T.SphereGeometry(.136,13,8),palette.skin,0,.61,0);
  const helmet=mesh(hips,new T.SphereGeometry(.16,13,8,0,Math.PI*2,0,Math.PI*.62),palette.dark,0,.655,0);
  helmet.scale.z=1.14;
  const limbs=[];
  for(const side of [-1,1]){
    const leg=new T.Group();leg.position.set(side*.129,.88,0);p.add(leg);
    mesh(leg,new T.CapsuleGeometry(.087,.29,4,7),cloth,0,-.24,0);
    const knee=new T.Group();knee.position.y=-.45;leg.add(knee);
    mesh(knee,new T.CapsuleGeometry(.067,.24,4,7),palette.dark,0,-.175,0);
    box(knee,.155,.13,.25,palette.boot,0,-.365,-.04);
    const arm=new T.Group();arm.position.set(side*.278,.40,0);hips.add(arm);arm.rotation.z=side*.15;
    mesh(arm,new T.CapsuleGeometry(.074,.21,4,7),cloth,0,-.16,0);
    mesh(arm,new T.CapsuleGeometry(.058,.16,4,7),palette.skin,0,-.40,-.035);
    limbs.push({leg,knee,arm,side});
  }
  return {p,hips,limbs};
}
const player=personnage('player'), contact=personnage('contact'), ally=personnage('ally');
scene.add(player.p,contact.p,ally.p);
ally.p.position.set(0,groundHeight(0,-26),-26);
const marker=mesh(scene,new T.TorusGeometry(.75,.043,7,35),glow,0,1.7,-24,false);
marker.rotation.x=Math.PI*.5;
const beacon=mesh(scene,new T.OctahedronGeometry(.18),glow,0,2.78,-24,false);

function animatePerson(actor,t,pace){
  const s=t*10;
  actor.hips.position.y=.92+Math.sin(t*3)*.013+Math.abs(Math.sin(s))*.021*pace;
  for(const {leg,knee,arm,side} of actor.limbs){
    const gait=Math.sin(s)*side;
    leg.rotation.x=gait*.61*pace;
    knee.rotation.x=Math.max(0,-gait)*.68*pace;
    arm.rotation.x=-gait*.52*pace+.08;
  }
}

const keys=new Set(), pos=new T.Vector3(0,0,19), velocity=new T.Vector3(), cameraPos=new T.Vector3();
const mouse={id:null,x:0,y:0};
let yaw=0,pitch=0,shownYaw=0,shownPitch=0,spring=0,walk=0,boom=0,count=0,active=false,win=false,third=false,flash=0,last=performance.now();
let enemyX=0, enemyZ=10;
const libero=(x,z)=>!ostacoli.some(o=>(x-o.x)**2+(z-o.z)**2<o.r**2);
const norm=(a)=>Math.atan2(Math.sin(a),Math.cos(a));
const vicino=()=>Math.hypot(pos.x,pos.z+24)<2.1;
const azione=(nome)=>regole[count][vicino()?1:0][nome];
function hud(testo){
  el('progresso').textContent=count+' / 100';
  stato.textContent=testo || (count===100?'Raggiungi la base e premi E.':'Missione in corso');
}
function apparizione(){
  const distanza=7+(count%7)*.6, angle=yaw+Math.sin(count*1.41)*.24;
  enemyX=T.MathUtils.clamp(pos.x-Math.sin(angle)*distanza,-20,20);
  enemyZ=T.MathUtils.clamp(pos.z-Math.cos(angle)*distanza,-30,29);
}
function mira(){
  const dx=enemyX-pos.x,dz=enemyZ-pos.z;
  return norm(Math.atan2(-dx,-dz)-yaw);
}
function aziona(code){
  if(!active||win)return;
  if(code==='KeyV'){third=!third;return;}
  if(code==='KeyE'){
    if(azione('soccorso').vittoria){win=true;hud('Missione completata. Compagno liberato.');}
    else hud(vicino()?'Completa il percorso prima del soccorso.':'Avvicinati al segnale della base.');
    return;
  }
  if(code!=='Space'||count>=100)return;
  flash=performance.now()+125;
  if(Math.abs(mira())>.16){hud('Allinea il mirino.');return;}
  count=azione('azione').passati;apparizione();hud();
}
function startGame(){
  count=azione('riavvio').passati;pos.set(0,0,19);velocity.set(0,0,0);
  yaw=shownYaw=0; pitch=shownPitch=0; spring=boom=0; third=false;win=false;active=true;keys.clear();apparizione();
  start.textContent='Ricomincia';hud();canvas.focus();
}
start.addEventListener('click',startGame);
const controlli=new Set(['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space','KeyE','KeyV']);
document.addEventListener('keydown',e=>{if(!controlli.has(e.code))return;e.preventDefault();keys.add(e.code);if(!e.repeat)aziona(e.code);});
document.addEventListener('keyup',e=>keys.delete(e.code));
window.addEventListener('blur',()=>keys.clear());
canvas.addEventListener('pointerdown',e=>{if(mouse.id!==null)return;mouse.id=e.pointerId;mouse.x=e.clientX;mouse.y=e.clientY;canvas.setPointerCapture(e.pointerId);canvas.focus();});
canvas.addEventListener('pointermove',e=>{if(e.pointerId!==mouse.id)return;yaw-= (e.clientX-mouse.x)*.004;pitch=T.MathUtils.clamp(pitch+(e.clientY-mouse.y)*.003,-.55,.67);mouse.x=e.clientX;mouse.y=e.clientY;});
for(const type of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(type,e=>{if(e.pointerId===mouse.id)mouse.id=null;});
document.querySelectorAll('[data-key]').forEach(b=>{
  const code=b.dataset.key;b.addEventListener('pointerdown',e=>{b.setPointerCapture(e.pointerId);keys.add(code);aziona(code);});
  for(const type of ['pointerup','pointercancel','lostpointercapture'])b.addEventListener(type,()=>keys.delete(code));
});
function resize(){
  const {width,height}=canvas.getBoundingClientRect();if(!width||!height)return;
  renderer.setSize(width,height,false);camera.aspect=width/height;camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(canvas);resize();
window.scenarioVista=()=>({x:pos.x,z:pos.z,yaw,delta:mira(),base:vicino(),count,win,third});

function frame(now){
  const dt=Math.min(.042,(now-last)/1000);last=now;
  if(active&&!win){
    yaw+=(Number(keys.has('ArrowLeft'))-Number(keys.has('ArrowRight')))*dt*1.85;
    const f=Number(keys.has('KeyW')||keys.has('ArrowUp'))-Number(keys.has('KeyS')||keys.has('ArrowDown'));
    const side=Number(keys.has('KeyD'))-Number(keys.has('KeyA'));
    const blend=1-Math.exp(-dt*12), scale=6.5/Math.max(1,Math.hypot(f,side));
    velocity.x+=((-Math.sin(yaw)*f+Math.cos(yaw)*side)*scale-velocity.x)*blend;
    velocity.z+=((-Math.cos(yaw)*f-Math.sin(yaw)*side)*scale-velocity.z)*blend;
    const x=T.MathUtils.clamp(pos.x+velocity.x*dt,-29,29),z=T.MathUtils.clamp(pos.z+velocity.z*dt,-25.4,32);
    if(libero(x,pos.z))pos.x=x;
    if(libero(pos.x,z))pos.z=z;
  }
  const speed=active&&!win?velocity.length():0;
  walk+=speed*dt*2.1;
  shownYaw+=norm(yaw-shownYaw)*(1-Math.exp(-dt*19));shownPitch+=(pitch-shownPitch)*(1-Math.exp(-dt*15));
  spring+=(Math.sin(walk)*speed*.008-spring)*(1-Math.exp(-dt*14));
  pos.y=groundHeight(pos.x,pos.z);
  boom+=((third?1:0)-boom)*(1-Math.exp(-dt*10));
  cameraPos.set(pos.x+Math.sin(shownYaw)*4.2*boom,pos.y+1.63+1.22*boom+spring,pos.z+Math.cos(shownYaw)*4.2*boom);
  camera.position.copy(cameraPos);camera.rotation.set(-shownPitch-.19*boom,shownYaw,0);
  player.p.visible=boom>.25;player.p.position.copy(pos);player.p.rotation.y=yaw;animatePerson(player,now*.001,speed/6.5);
  contact.p.visible=active&&count<100;contact.p.position.set(enemyX,groundHeight(enemyX,enemyZ),enemyZ);contact.p.rotation.y=Math.atan2(enemyX-pos.x,enemyZ-pos.z);
  animatePerson(contact,now*.001,.17);animatePerson(ally,now*.001,.05);
  marker.position.y=.08+Math.sin(now*.003)*.02;beacon.rotation.y=now*.001;beacon.position.y=2.8+Math.sin(now*.002)*.16;
  document.querySelector('.reticle').classList.toggle('on',now<flash||active&&count<100&&Math.abs(mira())<.16);
  renderer.render(scene,camera);
  requestAnimationFrame(frame);
}
start.disabled=false;
requestAnimationFrame(frame);
