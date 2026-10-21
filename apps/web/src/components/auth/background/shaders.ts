// 来自用户提供的「龙少女-动态壁纸」，保留原画的区域变形、闭眼补图与花瓣采样。
export const vertexShader = `
 precision highp float;
 attribute vec2 aPosition;
 attribute vec4 aRig0;
 attribute vec4 aRig1;
 attribute vec4 aRig2;
 attribute float aTail;
 uniform vec2 uViewport;
 uniform vec2 uPointer;
 uniform vec2 uOffset;
 uniform float uScale,uTime,uStrength;
 varying vec2 vUV;
 void main(){
  vec2 p=aPosition, d=vec2(0.0);
  float t=uTime, breath=sin(t*1.48), wind=sin(t*.79)+.32*sin(t*1.61+.9);
  float a=(sin(t*.57)*.006+uPointer.x*.012)*uStrength;
  vec2 neck=vec2(446.0,356.0), h=p-neck;
  vec2 rotated=vec2(h.x*cos(a)-h.y*sin(a),h.x*sin(a)+h.y*cos(a));
  d+=(rotated-h+vec2(uPointer.x*1.5,-breath*1.15+uPointer.y*1.6)*uStrength)*aRig0.x;
  d+=vec2((p.x-442.0)*.005*breath,-2.4*breath+uPointer.y*.4)*aRig0.y*uStrength;
  float tip=smoothstep(250.0,850.0,p.y);
  d+=vec2((wind*4.8+sin(t*1.12-p.y*.011)*2.7)*(0.3+tip),cos(t*.87-p.y*.008)*1.65)*aRig0.z*uStrength;
  d+=vec2(sin(t*.94-p.y*.014)*3.2-wind*1.4,cos(t*.85-p.y*.007)*1.3)*aRig0.w*uStrength;
  d+=vec2(sin(t*.7)*.8,-breath*1.9+sin(t*.62)*.8)*aRig1.x*uStrength;
  d+=vec2(-sin(t*.9)*2.4,cos(t*.9)*2.8)*aRig1.y*uStrength;
  d+=vec2(sin(t*.76-p.y*.009)*3.2,-breath*.8+sin(t*.83-p.y*.008)*1.5)*aRig1.z*uStrength;
  // 尾巴沿长度错开相位，形成缓慢轻摆，而不是整块图片平移。
  float tailPhase=t*.95-(p.y-675.0)*.009;
  d+=vec2(sin(tailPhase)*6.0,cos(tailPhase+.4)*3.5)*aTail*uStrength;
  // 同一阵风传到不同花穗的时间不同；根部固定，越靠近花梢越明显。
  float gust=sin(t*.72)+.28*sin(t*1.37+.8);
  float leftTip=smoothstep(4.0,205.0,p.y);
  float rightTip=smoothstep(3.0,205.0,p.y);
  float leftSway=gust*8.2+sin(t*1.32-p.y*.015+p.x*.025)*3.0;
  float rightSway=sin(t*.72-.65)*8.7+sin(t*1.19-p.y*.018+p.x*.02)*3.2;
  d+=vec2(leftSway*leftTip,cos(t*.92+p.x*.018)*1.7*leftTip)*aRig2.x*uStrength;
  d+=vec2(rightSway*rightTip,sin(t*.85+p.x*.02)*1.7*rightTip)*aRig2.z*uStrength;
  d+=vec2((sin(t*.74-.2)*6.8+sin(t*1.1-p.y*.02)*2.0)*smoothstep(0.0,145.0,p.y),sin(t*.85)*1.1)*aRig1.w*uStrength;
  d+=vec2((gust*6.4+sin(t*1.2-p.y*.014)*2.2)*smoothstep(315.0,530.0,p.y),sin(t*.83-p.y*.01)*1.8)*aRig2.w*uStrength;
  float foreground=(1.0-smoothstep(.55,1.0,length((p-vec2(1630.0,929.0))/vec2(133.0,130.0))))*smoothstep(0.0,18.0,1672.0-p.x)*smoothstep(0.0,18.0,941.0-p.y);
  d+=vec2(sin(t*.70+.8)*5.0,cos(t*.82)*2.0)*foreground*uStrength;
  // 深度不同的区域响应量不同；远景只做极小的视差。
  d+=uPointer*vec2(1.7,.85)*aRig2.y*uStrength;
  vec2 clip=((p+d-vec2(836.0,470.5))*uScale+uOffset)/(uViewport*.5);
  gl_Position=vec4(clip.x,-clip.y,0.0,1.0);
  vUV=aPosition/vec2(1672.0,941.0);
 }`;

export const fragmentShader = `
 precision highp float;
 uniform sampler2D uImage;
 uniform sampler2D uRepair;
 uniform vec2 uSample;
 uniform float uBlink;
 varying vec2 vUV;
 float spot(vec2 p,vec2 center,vec2 radius){return 1.0-smoothstep(.74,1.12,length((p-center)/radius));}
 vec4 eyeBlink(vec4 color,vec2 p,vec2 center,float radius){
  vec2 v=p-center;
  float a=-.35,c=cos(a),s=sin(a);
  vec2 q=vec2(c*v.x+s*v.y,-s*v.x+c*v.y);
  float mask=1.0-smoothstep(.78,1.08,length(q/vec2(radius*1.3,20.0)));
  if(mask<.001)return color;
  vec4 shut=texture2D(uRepair,vUV);
  float side=clamp(abs(q.x)/radius,0.0,1.0);
  float top=-8.7+5.0*side*side,bottom=8.0-3.0*side*side;
  float lid=mix(top,bottom,uBlink);
  float srcY=bottom+(q.y-bottom)/max(1.0-uBlink,.025);
  vec2 sourceLocal=vec2(q.x,srcY);
  vec2 sourcePoint=center+vec2(c*sourceLocal.x-s*sourceLocal.y,s*sourceLocal.x+c*sourceLocal.y);
  vec4 compressed=texture2D(uImage,sourcePoint/vec2(1672.0,941.0));
  float visible=smoothstep(lid-.6,lid+.6,q.y)*(1.0-smoothstep(bottom+.2,bottom+1.7,q.y));
  visible*=1.0-smoothstep(radius-.7,radius+1.0,abs(q.x));
  visible*=1.0-smoothstep(.80,.98,uBlink);
  vec4 closing=mix(shut,compressed,visible);
  return mix(color,closing,mask*smoothstep(0.0,.10,uBlink));
 }
 void main(){
  vec4 color=(texture2D(uImage,vUV+uSample)+texture2D(uImage,vUV-uSample)+texture2D(uImage,vUV+vec2(uSample.x,-uSample.y))+texture2D(uImage,vUV+vec2(-uSample.x,uSample.y)))*.25;
  vec2 p=vUV*vec2(1672.0,941.0);
  float cleaned=spot(p,vec2(842.0,313.0),vec2(25.0,37.0));
  cleaned=max(cleaned,spot(p,vec2(728.0,53.0),vec2(20.0,15.0)));
  cleaned=max(cleaned,spot(p,vec2(857.0,111.0),vec2(19.0,25.0)));
  cleaned=max(cleaned,spot(p,vec2(1542.0,731.0),vec2(50.0,43.0)));
  cleaned=max(cleaned,spot(p,vec2(1550.0,583.0),vec2(51.0,44.0)));
  cleaned=max(cleaned,spot(p,vec2(1390.0,800.0),vec2(32.0,29.0)));
  cleaned=max(cleaned,spot(p,vec2(1220.0,864.0),vec2(32.0,29.0)));
  cleaned=max(cleaned,spot(p,vec2(1364.0,900.0),vec2(31.0,26.0)));
  color=mix(color,texture2D(uRepair,vUV),cleaned);
  if(uBlink>.001){color=eyeBlink(color,p,vec2(376.0,255.5),26.0);color=eyeBlink(color,p,vec2(452.5,228.5),24.0);}
  gl_FragColor=color;
 }`;

export const spriteVertexShader = `
 precision highp float;
 attribute vec2 aCorner;
 uniform vec4 uSource,uPose;
 uniform vec2 uStretch,uViewport,uOrigin;
 uniform float uScale;
 varying vec2 vUV,vCorner;
 void main(){
  vec2 local=aCorner*uSource.zw*uStretch*uPose.z;
  float c=cos(uPose.w),s=sin(uPose.w);
  vec2 p=uPose.xy+vec2(c*local.x-s*local.y,s*local.x+c*local.y);
  vec2 clip=(p*uScale+uOrigin)/(uViewport*.5)-1.0;
  gl_Position=vec4(clip.x,-clip.y,0.0,1.0);
  vUV=(uSource.xy+aCorner*uSource.zw)/vec2(1672.0,941.0);vCorner=aCorner;
 }`;

export const spriteFragmentShader = `
 precision highp float;
 uniform sampler2D uImage,uRepair;
 uniform vec4 uSource;
 uniform float uOpacity;
 varying vec2 vUV,vCorner;
 void main(){
  vec3 ink=texture2D(uImage,vUV).rgb,back=texture2D(uRepair,vUV).rgb;
  vec3 diff=abs(ink-back);
  float delta=max(max(diff.r,diff.g),diff.b);
  float alpha=smoothstep(.015,.14,delta);
  // 只提取被移除的紫色花瓣，排除补景时背景细线的细小色差。
  vec3 removed=back-ink;
  float petalSignal=removed.g-(removed.r+removed.b)*.4;
  alpha*=smoothstep(.003,.030,petalSignal);
  alpha*=1.0-smoothstep(.78,1.02,length(vCorner));
  if(uSource.y>550.0&&uSource.y<630.0){
   vec2 d=vUV*vec2(1672.0,941.0)-vec2(1547.0,581.0);
   vec2 leaf=vec2(.752*d.x-.659*d.y,.659*d.x+.752*d.y)/vec2(33.0,18.5);
   alpha*=1.0-smoothstep(.80,1.13,length(leaf));
  }
  vec3 foreground=clamp((ink-back*(1.0-alpha))/max(alpha,.001),0.0,1.0);
  gl_FragColor=vec4(foreground,alpha*uOpacity);
 }`;
