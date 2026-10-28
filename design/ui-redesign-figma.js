/**
 * createVariableCollection
 *
 * Creates a new Figma variable collection with the specified name and modes.
 * If `modeNames` has more than one entry, the first mode is renamed from
 * Figma's default "Mode 1" to the first name, and additional modes are added.
 *
 * @param {string} name - The display name of the collection (e.g. "Color", "Spacing").
 * @param {string[]} modeNames - Ordered list of mode names (e.g. ["Light", "Dark"] or ["Value"]).
 * @returns {Promise<{
 *   collection: VariableCollection,
 *   modeIds: Record<string, string>
 * }>}
 *   `modeIds` maps each mode name to its modeId string.
 */
async function createVariableCollection(name, modeNames) {
  if (!modeNames || modeNames.length === 0) {
    throw new Error('createVariableCollection: modeNames must have at least one entry.')
  }

  // Create the collection — Figma always creates it with one mode named "Mode 1".
  const collection = figma.variables.createVariableCollection(name)

  // modeIds accumulator
  const modeIds = {}

  // Rename the default first mode
  const defaultMode = collection.modes[0]
  collection.renameMode(defaultMode.modeId, modeNames[0])
  modeIds[modeNames[0]] = defaultMode.modeId

  // Add additional modes
  for (let i = 1; i < modeNames.length; i++) {
    const newModeId = collection.addMode(modeNames[i])
    modeIds[modeNames[i]] = newModeId
  }

  return { collection, modeIds }
}


/**
 * createComponentWithVariants
 *
 * Creates a component set by generating all combinations of `variantAxes`,
 * building one Figma component per combination, then calling
 * `figma.combineAsVariants` to produce the component set. After combining,
 * the variants are repositioned into a grid so they don't all stack at (0, 0).
 *
 * @param {{
 *   name: string,
 *   description?: string,
 *   variantAxes: Record<string, string[]>,
 *   baseProps: {
 *     width: number,
 *     height: number,
 *     fills?: Paint[],
 *     padding?: {top?: number, bottom?: number, left?: number, right?: number},
 *     radius?: number,
 *     layoutMode?: 'HORIZONTAL' | 'VERTICAL' | 'NONE',
 *     itemSpacing?: number
 *   },
 *   page: PageNode
 * }} config
 *   - `name`: Component set name (e.g. "Button").
 *   - `description`: Optional human-readable purpose and usage guidance.
 *   - `variantAxes`: Each key is a variant property name; each value is an array of
 *     allowed values. All combinations are generated (Cartesian product).
 *     Example: { Size: ['Small', 'Medium', 'Large'], Style: ['Primary', 'Ghost'] }
 *     produces 6 variants.
 *   - `baseProps`: Visual properties applied to every variant.
 *   - `page`: The PageNode to create components on (must be set as current page by caller).
 * @returns {Promise<{
 *   componentSet: ComponentSetNode,
 *   variants: ComponentNode[]
 * }>}
 */
async function createComponentWithVariants(config) {
  const { name, variantAxes, baseProps, page } = config

  // Ensure we are on the correct page
  /* already selected once for this call */

  // Compute Cartesian product of variant axes
  const axisNames = Object.keys(variantAxes)
  const axisValues = axisNames.map((k) => variantAxes[k])
  const combinations = cartesianProduct(axisValues)

  // Build one component per combination
  const components = []
  for (const combo of combinations) {
    const comp = figma.createComponent()

    // Name: "Property=Value, Property=Value, ..."
    comp.name = axisNames.map((ax, i) => `${ax}=${combo[i]}`).join(', ')

    // Base geometry
    comp.resize(baseProps.width, baseProps.height)

    // Fills
    if (baseProps.fills !== undefined) {
      comp.fills = baseProps.fills
    } else {
      comp.fills = [{ type: 'SOLID', color: { r: 0.9, g: 0.9, b: 0.9 } }]
    }

    // Corner radius
    if (baseProps.radius !== undefined) {
      comp.cornerRadius = baseProps.radius
    }

    // Auto-layout
    if (baseProps.layoutMode && baseProps.layoutMode !== 'NONE') {
      comp.layoutMode = baseProps.layoutMode
      comp.primaryAxisAlignItems = 'CENTER'
      comp.counterAxisAlignItems = 'CENTER'
      if (baseProps.itemSpacing !== undefined) {
        comp.itemSpacing = baseProps.itemSpacing
      }
    }

    // Padding
    if (baseProps.padding) {
      comp.paddingTop = baseProps.padding.top ?? 0
      comp.paddingBottom = baseProps.padding.bottom ?? 0
      comp.paddingLeft = baseProps.padding.left ?? 0
      comp.paddingRight = baseProps.padding.right ?? 0
    }

    page.appendChild(comp)
    components.push(comp)
  }

  // Combine into a component set
  const componentSet = figma.combineAsVariants(components, page)
  componentSet.name = name
  if (config.description) {
    componentSet.description = config.description
  }

  // Grid layout — variants stack at (0, 0) after combineAsVariants; reposition them.
  const GRID_GAP = 16
  const cols = Math.max(1, axisValues[axisValues.length - 1]?.length ?? 1)
  const variantWidth = baseProps.width
  const variantHeight = baseProps.height

  componentSet.children.forEach((variant, idx) => {
    const col = idx % cols
    const row = Math.floor(idx / cols)
    variant.x = col * (variantWidth + GRID_GAP)
    variant.y = row * (variantHeight + GRID_GAP)
  })

  // Resize component set to wrap its children with padding
  const totalCols = Math.min(cols, combinations.length)
  const totalRows = Math.ceil(combinations.length / cols)
  const PADDING = 40
  componentSet.resize(
    totalCols * variantWidth + (totalCols - 1) * GRID_GAP + PADDING * 2,
    totalRows * variantHeight + (totalRows - 1) * GRID_GAP + PADDING * 2,
  )

  // Position component set at a safe canvas location
  componentSet.x = 480
  componentSet.y = 80

  return { componentSet, variants: componentSet.children }
}

/**
 * Computes the Cartesian product of multiple arrays.
 * cartesianProduct([[A, B], [1, 2]]) → [[A,1], [A,2], [B,1], [B,2]]
 *
 * @param {Array<string[]>} arrays
 * @returns {string[][]}
 */
function cartesianProduct(arrays) {
  return arrays.reduce(
    (acc, curr) => acc.flatMap((combo) => curr.map((val) => [...combo, val])),
    [[]],
  )
}



const page = await figma.getNodeByIdAsync('0:1');
await figma.setCurrentPageAsync(page);
await Promise.all(['Regular','Medium','Bold'].map(style=>figma.loadFontAsync({family:'Noto Sans SC',style})));
if (page.children.some(n=>n.name==='AI 学习助手 / 整体液态玻璃')) throw new Error('Design already exists; inspect before editing.');
const rgb = hex => ({r:parseInt(hex.slice(1,3),16)/255,g:parseInt(hex.slice(3,5),16)/255,b:parseInt(hex.slice(5,7),16)/255});
const {collection:primitives,modeIds:pm} = await createVariableCollection('Panel primitives',['Value']);
const {collection:semantics,modeIds:sm} = await createVariableCollection('Panel surfaces',['Light']);
const vars = {};
function token(name,value,scope,css) {
  const p=figma.variables.createVariable('raw/'+name,primitives,typeof value==='number'?'FLOAT':'COLOR');
  p.scopes=[]; p.setValueForMode(pm.Value,value);
  const v=figma.variables.createVariable(name,semantics,typeof value==='number'?'FLOAT':'COLOR');
  v.scopes=scope; v.setValueForMode(sm.Light,{type:'VARIABLE_ALIAS',id:p.id});
  v.setVariableCodeSyntax('WEB','var('+css+')'); vars[name]=v; return v;
}
token('ink',rgb('#192338'),['TEXT_FILL'],'--ink');
token('muted',rgb('#59667e'),['TEXT_FILL'],'--muted');
token('accent',rgb('#465bea'),['TEXT_FILL','FRAME_FILL','SHAPE_FILL'],'--pine');
token('success',rgb('#137c69'),['TEXT_FILL','FRAME_FILL','SHAPE_FILL'],'--ai-success');
token('sheet',{...rgb('#ffffff'),a:.54},['FRAME_FILL','SHAPE_FILL'],'--sheet');
token('edge',{...rgb('#ffffff'),a:.66},['STROKE_COLOR'],'--ai-glass-border');
token('rule',{...rgb('#63749b'),a:.16},['STROKE_COLOR'],'--rule');
token('space16',16,['GAP'],'--ai-space');
const paint=(key,opacity)=>{let p=figma.variables.setBoundVariableForPaint({type:'SOLID',color:rgb('#ffffff')},'color',vars[key]); if(opacity!==undefined)p.opacity=opacity;return p;};
const solid=(hex,opacity=1)=>({type:'SOLID',color:rgb(hex),opacity});
const styles={};
for(const [name,size,style] of [['Caption',10,'Regular'],['Small',11,'Regular'],['Body',12,'Regular'],['Label',12,'Medium'],['Section',14,'Medium'],['Brand',15,'Bold'],['Title',20,'Bold'],['Board',28,'Bold']]){
  const s=figma.createTextStyle();s.name='Panel / '+name;s.fontName={family:'Noto Sans SC',style};s.fontSize=size;s.lineHeight={unit:'PERCENT',value:150};styles[name]=s;
}
function text(value,style='Body',color='ink',width) {
  const n=figma.createText();n.name=value.slice(0,36);n.textStyleId=styles[style].id;n.characters=value;n.fills=[paint(color)];
  if(width){n.textAutoResize='HEIGHT';n.resize(width,n.height);}
  return n;
}
function auto(name,width,direction='VERTICAL',gap=0){
  const n=figma.createAutoLayout();n.name=name;n.layoutMode=direction;n.resize(width,10);n.primaryAxisSizingMode=direction==='HORIZONTAL'?'FIXED':'AUTO';n.counterAxisSizingMode=direction==='HORIZONTAL'?'AUTO':'FIXED';n.itemSpacing=gap;n.fills=[];return n;
}
function pad(n,v){n.paddingTop=v;n.paddingBottom=v;n.paddingLeft=v;n.paddingRight=v;}
function glass(n,r=14,opacity=.42){n.cornerRadius=r;n.fills=[solid('#ffffff',opacity)];n.strokes=[paint('edge')];n.strokeWeight=1;n.effects=[{type:'INNER_SHADOW',color:{...rgb('#ffffff'),a:.6},offset:{x:0,y:1},radius:0,spread:0,visible:true,blendMode:'NORMAL'}];}
function add(parent,node,fill=false){parent.appendChild(node);if(fill||(node.type==='FRAME'&&node.layoutMode==='HORIZONTAL'&&parent.layoutMode==='VERTICAL'))node.layoutSizingHorizontal='FILL';return node;}
const space16 = await figma.variables.importVariableByKeyAsync('16bc6f84b6e7e20e4234ef79030ee580ec0f4505');
const buttonFamily = await createComponentWithVariants({name:'Panel / Glass action',description:'Compact glass actions used for navigation, secondary controls and saving. Labels stay editable.',variantAxes:{Appearance:['Glass','Primary','Selected','Quiet']},baseProps:{width:88,height:34,radius:11,layoutMode:'HORIZONTAL',padding:{left:12,right:12}},page});
buttonFamily.componentSet.x=80;buttonFamily.componentSet.y=1320;
buttonFamily.componentSet.resize(480,100);
const buttons={};
const buttonLabelProp=buttonFamily.componentSet.addComponentProperty('Label','TEXT','操作');
for(const c of buttonFamily.variants){
  const type=c.name.split('=')[1];buttons[type]=c;glass(c,11,type==='Quiet'?0:type==='Selected'?.74:.48);
  if(type==='Primary'){c.fills=[paint('accent',.94)];}
  if(type==='Quiet'){c.strokes=[];c.effects=[];}
  const l=text('操作','Label',type==='Primary'?'ink':type==='Quiet'?'muted':'accent');
  if(type==='Primary')l.fills=[solid('#ffffff')];
  c.appendChild(l);l.componentPropertyReferences={characters:buttonLabelProp};
  c.setBoundVariable('paddingLeft',space16);c.setBoundVariable('paddingRight',space16);
  c.x=['Glass','Primary','Selected','Quiet'].indexOf(type)*116;c.y=20;
}
function button(label,kind,width=88,height=34){const n=buttons[kind].createInstance();n.setProperties({[buttonLabelProp]:label});n.resize(width,height);return n;}
const field = figma.createComponent();field.name='Panel / Glass input';field.description='Editable text field, 38px tall; same translucent material as the panel.';field.layoutMode='HORIZONTAL';field.counterAxisAlignItems='CENTER';field.resize(362,38);field.primaryAxisSizingMode='FIXED';pad(field,10);glass(field,11,.5);field.x=80;field.y=1470;
const fieldText=text('模型或接口地址','Body');field.appendChild(fieldText);const valueProp=field.addComponentProperty('Value','TEXT','模型或接口地址');fieldText.componentPropertyReferences={characters:valueProp};
function input(value,width=362,height=38){const n=field.createInstance();n.setProperties({[valueProp]:value});n.resize(width,height);return n;}
const board=auto('AI 学习助手 / 整体液态玻璃',1360,'VERTICAL',20);board.x=80;board.y=80;pad(board,32);board.fills=[solid('#edf1fa')];board.cornerRadius=28;
add(board,text('AI 学习助手','Board'));add(board,text('整体液态玻璃 · 概览、模型连接与窄屏体验','Body','muted'));
const row=add(board,auto('界面状态',1296,'HORIZONTAL',24));
function stage(name,width=432){const column=auto(name,width,'VERTICAL',12);add(row,column);add(column,text(name,'Section'));const n=figma.createFrame();n.name=name+' / 课程背景';n.resize(width,852);n.cornerRadius=22;n.fills=[solid('#f2f4fa')];n.clipsContent=true;add(column,n);
  const navy=figma.createRectangle();navy.name='课程导航背景';navy.resize(width*.42,852);navy.fills=[solid('#20334f')];n.appendChild(navy);
  const blue=figma.createRectangle();blue.name='课程内容蓝色区';blue.resize(width*.8,180);blue.x=width*.25;blue.y=150;blue.cornerRadius=22;blue.fills=[solid('#c4d9fa')];n.appendChild(blue);
  const violet=figma.createRectangle();violet.name='课程内容紫色区';violet.resize(width*.72,160);violet.x=width*.3;violet.y=420;violet.cornerRadius=18;violet.fills=[solid('#bdc3f5')];n.appendChild(violet);return n;
}
const bookSvg='<svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 5.5C7 4.6 9.6 5.1 12 6.7C14.4 5.1 17 4.6 20 5.5V18C17 17.1 14.4 17.6 12 19.2C9.6 17.6 7 17.1 4 18V5.5Z" stroke="#FFFFFF" stroke-width="1.6" stroke-linejoin="round"/><path d="M12 7V19" stroke="#FFFFFF" stroke-width="1.6" stroke-linecap="round"/></svg>';
function panel(stage,width,active){
 const p=auto('学习助手 / '+active,width,'VERTICAL',0);glass(p,26,.65);p.effects=[{type:'BACKGROUND_BLUR',radius:26,visible:true},{type:'DROP_SHADOW',color:{...rgb('#1d2a53'),a:.18},offset:{x:0,y:16},radius:40,spread:0,visible:true,blendMode:'NORMAL'}];p.x=16;p.y=30;stage.appendChild(p);
 const h=add(p,auto('品牌与收起',width,'HORIZONTAL',10));pad(h,16);h.counterAxisAlignItems='CENTER';
 const mark=auto('品牌',34,'HORIZONTAL');mark.resize(34,34);mark.primaryAxisSizingMode='FIXED';mark.counterAxisSizingMode='FIXED';mark.primaryAxisAlignItems='CENTER';mark.counterAxisAlignItems='CENTER';mark.cornerRadius=11;mark.fills=[paint('accent',.9)];mark.appendChild(figma.createNodeFromSvg(bookSvg));h.appendChild(mark);
 const titles=add(h,auto('品牌文字',width-112,'VERTICAL',1));add(titles,text('AI 学习助手','Brand'));add(titles,text('超星 · 课程学习','Caption','muted'));add(h,button('−','Glass',30,30));
 const body=add(p,auto('工作区',width,'VERTICAL',18));body.paddingLeft=16;body.paddingRight=16;body.paddingBottom=16;
 const nav=add(body,auto('分段导航',width-32,'HORIZONTAL',0));pad(nav,4);glass(nav,14,.22);
 for(const name of ['概览','解题','设置','帮助','关于'])add(nav,button(name,name===active?'Selected':'Quiet',(width-42)/5,32));
 return {p,body,w:width-32};
}
function overview(p){
 const card=add(p.body,auto('学习概览',p.w,'VERTICAL',10));pad(card,18);glass(card,19,.4);
 const line=add(card,auto('状态',p.w-36,'HORIZONTAL',8));line.primaryAxisAlignItems='SPACE_BETWEEN';add(line,text('学习状态','Small','muted'));const badge=add(line,auto('已完成标识',62,'HORIZONTAL'));pad(badge,4);glass(badge,99,.5);badge.fills=[solid('#daf8ed',.56)];badge.primaryAxisAlignItems='CENTER';add(badge,text('● 已完成','Caption','success'));
 add(card,text('本页任务已完成','Title'));add(card,text('已点击下一节，等待平台切换页面。','Body','muted',p.w-36));
 const metrics=add(card,auto('进度与模型',p.w-36,'HORIZONTAL',26));metrics.paddingTop=12;
 for(const [label,value] of [['任务进度','1 / 1'],['模型服务','DeepSeek']]){const m=add(metrics,auto(label,(p.w-62)/2,'VERTICAL',4));add(m,text(label,'Caption','muted'));add(m,text(value,'Section'));}
 const toolbar=add(p.body,auto('日志操作',p.w,'HORIZONTAL',8));toolbar.primaryAxisAlignItems='SPACE_BETWEEN';add(toolbar,text('运行记录  7','Section'));add(toolbar,button('复制日志','Glass',82,30));
 const modes=add(p.body,auto('简要与详细',p.w,'HORIZONTAL',4));add(modes,button('简要','Selected',52,27));add(modes,button('详细','Quiet',52,27));
 const logs=add(p.body,auto('关键记录',p.w,'VERTICAL',0));pad(logs,12);glass(logs,15,.25);
 for(const [t,msg] of [['21:49:02','平台已确认本页任务完成'],['21:49:02','已点击下一节，等待平台切换页面']]){const log=add(logs,auto('日志条目',p.w-24,'HORIZONTAL',9));log.paddingTop=10;log.paddingBottom=10;add(log,text(t,'Caption','muted'));add(log,text('●','Caption','success'));add(log,text(msg,'Small','ink',p.w-111));}
}
const desktop=stage('概览 / 396 px');const d=panel(desktop,396,'概览');overview(d);
const modelStage=stage('模型连接 / 396 px');const m=panel(modelStage,396,'解题');
add(m.body,text('暂无题目，可先完成模型配置。','Small','muted',m.w));
const form=add(m.body,auto('模型连接',m.w,'VERTICAL',10));add(form,text('模型连接','Section'));
for(const [label,value] of [['模型服务','DeepSeek'],['DeepSeek API Key','••••••••••••••••'],['模型名称','deepseek-chat'],['解题请求 URL','https://api.deepseek.com/chat/completions']]){
 add(form,text(label,'Small')); if(label==='模型名称'){const mr=add(form,auto('模型与获取',m.w,'HORIZONTAL',8));add(mr,input(value,m.w-100));add(mr,button('获取模型','Glass',92,38));}else add(form,input(value,m.w,label.includes('URL')?58:38));
}
add(form,text('图像题需使用支持图像的模型。','Caption','muted'));
const disclosure=add(form,auto('接口设置',m.w,'HORIZONTAL'));disclosure.paddingTop=12;disclosure.paddingBottom=12;add(disclosure,text('›   模型列表与接口设置','Small','muted'));
add(form,text('解题偏好','Section'));add(form,text('思考程度','Small'));add(form,input('默认（跟随模型）',m.w));
const save=add(m.body,auto('固定保存操作',m.w,'VERTICAL',8));add(save,text('两家配置分别保存，刷新后开始使用。','Caption','muted'));add(save,button('保存并刷新','Primary',m.w,41));
const narrowStage=stage('概览 / 320 px',344);const n=panel(narrowStage,304,'概览');overview(n);
add(board,text('交互节奏','Section'));add(board,text('展开 220 ms · 收起反馈 160 ms · 页签 160 ms · 操作按下立即反馈；减少动态效果时使用短淡入。','Body','muted',1296));
const counts={};for(const node of board.findAll(()=>true))counts[node.type]=(counts[node.type]||0)+1;
const imageNodes=board.findAll(n=>'fills' in n && Array.isArray(n.fills) && n.fills.some(p=>p.type==='IMAGE')).map(n=>({id:n.id,name:n.name}));
const all=page.findAll(()=>true);
return {createdNodeIds:[board.id,...all.map(n=>n.id)],mutatedNodeIds:[],boardId:board.id,buttonSetId:buttonFamily.componentSet.id,inputComponentId:field.id,collectionIds:[primitives.id,semantics.id],variableIds:Object.values(vars).map(v=>v.id),textStyleIds:Object.values(styles).map(s=>s.id),counts,imageNodes,fontFamilies:[...new Set(board.findAllWithCriteria({types:['TEXT']}).map(t=>t.fontName.family))],bounds:{width:board.width,height:board.height}};
