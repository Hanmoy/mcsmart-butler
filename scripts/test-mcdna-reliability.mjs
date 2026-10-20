// 战报数据可靠性回归：模拟官方响应；不读取真实用户订单或凭据。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const home=mkdtempSync(join(tmpdir(),'mcsmart-mcdna-'));process.env.MCSMART_HOME=home;
const {extractOrders}=await import('../dist/orders.js');
const {fetchMcdnaStats,aggregateMcdna,normalizeForStats,buildMcdnaSvg}=await import('../dist/mcdna.js');
const {serviceMcdna}=await import('../dist/service.js');
const {createMcdnaSnapshot,renderMcdnaReport}=await import('../dist/mcdnaReport.js');
const {personaOf}=await import('../dist/mcdnaPersona.js');
let checks=0;const check=(value,note)=>{assert.ok(value,note);checks++;};
try {
  for(const count of [0,1,4,5]){
    let calls=0;const client={call:async(name)=>{calls++;return {data:Array.from({length:count},()=>({items:[{name:'麦香鸡',quantity:1,price:12.34}]})),rawText:''};}};
    const s=await fetchMcdnaStats(client,{demo:false});
    check(!s.demo&&s.orderCount===count,`${count}单不换演示`);
    check(s.dataState===(count===0?'empty':count<5?'cold-start':'ready'),`${count}单状态正确`);
    check(count<5?!/健康/.test(s.hero.title):true,'不编造健康画像');
  }
  for(const message of ['HTTP 401','连接失败或超时'])await assert.rejects(fetchMcdnaStats({call:async()=>{throw Error(message);}},{demo:false}),new RegExp(message));
  const five=(item)=>extractOrders(Array.from({length:5},()=>({items:[item]})));
  const agg=(orders,table=null)=>aggregateMcdna(orders,{demo:false,amountMode:'full',table});
  check(agg(five({name:'汉堡',quantity:2,subtotal:40})).totalSpendCents===20000,'行合计不能二次乘数量');
  check(agg(five({name:'汉堡',quantity:2,price:20})).totalSpendCents===20000,'单价乘份数与小计一致');
  check(agg(five({name:'汉堡',quantity:1,price:128})).totalSpendCents===64000,'超过100元不猜为分');
  check(agg(five({name:'汉堡',quantity:1,priceCents:128})).totalSpendCents===640,'显式分单位');
  check(agg(five({name:'汉堡',quantity:1})).totalSpendCents===null,'缺金额不填0');
  check(agg(five({name:'汉堡',quantity:1,amount:128})).totalSpendCents===null,'模糊字段未声明单位不采信');
  check(agg(five({name:'汉堡',quantity:1,amount:128,moneyUnit:'yuan'})).totalSpendCents===64000,'模糊字段显式单位');
  check(agg(extractOrders([{paidCents:1234,refundCents:100,items:[]}])).totalSpendCents===1134,'实付和退款契约');
  check(normalizeForStats('可口可乐（无糖）')!==normalizeForStats('可口可乐（含糖）'),'糖型不合并');
  check(normalizeForStats('可口可乐中杯')!==normalizeForStats('可口可乐大杯'),'规格不合并');
  const row={productName:'鸡肉',protein:20,carbohydrate:0,fat:0,energyKcal:80,energyKj:330,sodium:0,calcium:0};
  const s=agg(extractOrders(Array.from({length:5},()=>({createTime:'2026-10-19 12:00:00',items:[{name:'鸡肉',quantity:1},{name:'未收录食物',quantity:10}]}))),new Map([['鸡肉',row]]));
  check(s.totalItemsQty===55&&s.pfcUnknownQty===50&&s.pfcKnownQty===5,'营养覆盖按份数守恒');
  check(!/健康|控卡|自律/.test(s.hero.sect),'营养不参与人格分型');
  check(buildMcdnaSvg(s).includes('未收录 50 份'),'兼容SVG显示营养缺口');
  const untimed=agg(five({name:'可口可乐（无糖）',quantity:1}));
  check(!/甜品|快乐水/.test(untimed.hero.sect+untimed.hero.blurb),'无糖饮料不推断甜食');
  check(untimed.hero.title==='麦门日常记录员','没有时间不推断饭点');
  for(const bad of [null,{}, {data:{oops:[]}},[null],[{items:'oops'}]])assert.throws(()=>extractOrders(bad));
  const report=await serviceMcdna(null,{demo:true});
  check(report.stats.demo&&report.frontSvg.includes('演示数据')&&report.backSvg.includes('演示数据')&&report.backSvg.includes('data-source="demo"'),'演示两面有来源');
  check(report.amountMode==='tier'&&report.stats.totalSpendCents===null,'默认脱敏响应不含金额');
  check(!/[¥￥]\s*\d/.test(report.frontSvg+report.backSvg),'脱敏两面不含金额');
  check(!report.commentaryRequest.prompt.includes('428.6'),'Agent提示不含金额');
  check(report.frontSvg.includes('data:image/png;base64,')&&!/href="(?!data:|#)/.test(report.frontSvg+report.backSvg),'素材内嵌、无外链');
  check(report.templateId==='status'&&report.persona.sectName==='单推派'&&report.persona.qualifier.word==='麦辣','演示按数据判派，限定词取本命（不是板烧）');
  check(!/板烧/.test(JSON.stringify(report.copy))&&!/板烧/.test(report.commentaryRequest.prompt.replace('用户的本命不一定是板烧','')),'规则文案与提示词不套板烧');
  await assert.rejects(serviceMcdna(null,{reportId:report.reportId,templateId:'sticker'}),e=>e.code==='E_INPUT_INVALID');
  const same=await serviceMcdna(null,{reportId:report.reportId});
  check(same.snapshotId===report.snapshotId&&same.hashes.front===report.hashes.front&&same.hashes.back===report.hashes.back,'同一快照重渲染逐字节一致');
  // 限定词随本命变化：单品主导取简称；多种汉堡都不过半时取类别词；份数并列时食物优先于饮料。
  const at=(d,h)=>`2026-10-${String(d).padStart(2,'0')} ${String(h).padStart(2,'0')}:10:00`;
  const persona=list=>personaOf(aggregateMcdna(extractOrders(list.map(([d,h,...items])=>({createTime:at(d,h),items:items.map(([name,quantity])=>({name,quantity}))}))),{demo:false,amountMode:'tier',table:null}));
  const bigmac=persona(Array.from({length:6},(_,i)=>[i+1,12,['巨无霸',2],['中薯条',1]]));
  check(bigmac.qualifier.word==='巨无霸'&&bigmac.body==='burger','巨无霸主导时限定词是巨无霸');
  const mixed=persona([[1,12,['麦辣鸡腿堡',2]],[2,12,['巨无霸',2]],[3,18,['麦香鸡',2]],[4,12,['板烧鸡腿堡',1],['麦辣鸡腿堡',1]],[6,13,['双层吉士汉堡',2]],[8,12,['麦香鱼',1],['中薯条',1]]]);
  check(mixed.qualifier.word==='汉堡'&&mixed.qualifier.level==='category','多种汉堡不过半时改用类别词「汉堡」');
  const tie=persona(Array.from({length:6},(_,i)=>[i+1,23,['可乐（含糖）中杯',1],['麦乐鸡5块',1]]));
  check(tie.body==='nugget'&&tie.facts.topShort!=='可乐','份数并列时本命取食物而非饮料');
  const empty=await renderMcdnaReport(createMcdnaSnapshot(aggregateMcdna(extractOrders([]),{demo:false,amountMode:'tier',table:null})),{});
  check(empty.commentaryRequest===null&&empty.commentaryStatus==='rules','零订单不发 Agent 请求');
  await assert.rejects(renderMcdnaReport(empty.reportId,{commentary:{snapshotId:empty.snapshotId,title:'麦门新人'}}),e=>e.code==='E_INPUT_INVALID');
  const good={snapshotId:report.snapshotId,title:'{qualifier}钉子户',verdict:'菜单翻遍还是{qualifier}',achievements:['本命打卡×{topCount}','深夜加更×{night}'],dialogue:'{topName}出现了{topCount}份。别人点餐靠选，你点餐靠认。',hook:'你的本命是哪一样？'};
  const accepted=await serviceMcdna(null,{reportId:report.reportId,commentary:good});
  check(accepted.commentaryStatus==='agent'&&accepted.frontSvg.includes('麦辣钉子户')&&accepted.backSvg.includes('别人点餐靠选')&&accepted.backSvg.includes('data-text-source="agent"'),'Agent 文案代入事实后上卡');
  check(accepted.copy.achievements[0]==='本命打卡×22'&&accepted.hashes.front!==report.hashes.front,'事实编号由程序代入');
  const again=await serviceMcdna(null,{reportId:report.reportId});
  check(again.hashes.back===accepted.hashes.back&&again.commentaryStatus==='agent','跨调用复用同一产物');
  const bads={其他快照:{...good,snapshotId:'bad'},虚构事实:{...good,achievements:['本命打卡×{invented}']},阿拉伯数字:{...good,dialogue:'你点了999单，别人点餐靠选，你点餐靠认。'},
    中文数量:{...good,dialogue:'你点了三十单，别人点餐靠选，你点餐靠认。'},健康结论:{...good,verdict:'你很健康自律'},没点过的板烧:{...good,title:'板烧钉子户'},
    他牌梗:{...good,hook:'疯狂星期四见？'},成就无事实:{...good,achievements:['本命打卡']},超长称号:{...good,title:'麦门麦门麦门麦门钉子户'},缺字段:{snapshotId:report.snapshotId,title:'麦辣钉子户'}};
  for(const [name,bad] of Object.entries(bads))await assert.rejects(serviceMcdna(null,{reportId:report.reportId,commentary:bad}),e=>e.code==='E_INPUT_INVALID',name);
  checks+=Object.keys(bads).length;
  const kept=await serviceMcdna(null,{reportId:report.reportId});
  check(kept.hashes.back===accepted.hashes.back,'被拒文案不覆盖已接受文案');
  await assert.rejects(serviceMcdna(null,{reportId:'../../config.json'}),e=>e.code==='E_INPUT_INVALID');
  const full=await serviceMcdna(null,{reportId:report.reportId,amountMode:'full'});
  check(full.frontSvg.includes('¥428.60'),'分位显示');
  check(full.snapshotId===report.snapshotId,'脱敏切换不重新取数');
  console.log(`McDNA可靠性：${checks}项断言通过（模拟订单；v6 麦门状态栏）`);
} finally {rmSync(home,{recursive:true,force:true});}
