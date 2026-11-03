/* FLUXO DE CAIXA v2.0 — app.js */
const CH_RECEITAS='sistemaFluxo.v1',CH_PAGAMENTOS='sistemaPagamentos.v2';
const CH_GH='sistemaFluxo.github',CH_GH_PAG='sistemaPagamentos.github';
const CH_MES='sistemaFluxo.mesRef',CH_DIRTY='sistemaFluxo.dirty';
const PARCELAS_INICIAIS=24,PARCELAS_MIN_FUTURAS=12,LIMITE_GH=900*1024;
const TIPO_LABEL={aluguel:'Aluguel',holerite:'Holerite',aposentadoria:'Aposentadoria',outro:'Outro'};

let receitas=[],dividasPagamentos=[],editandoId=null,fonteDespesas='';
let mesRef=new Date(),resolverEscopo=null,syncTimer=null,syncing=false,edicaoValorPendente=null;
let telaAtual='fluxo';
let graficosPeriodo='quinzenal',graficosTipo='linha',graficoAtual=null;
const cronoDiasExpandidos=new Set();

const gid=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,8);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtBRL=v=>Number(v||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
const arr2=v=>Math.round((Number(v)+Number.EPSILON)*100)/100;
const isoParaData=iso=>{const[a,m,d]=iso.split('-').map(Number);return new Date(a,m-1,d)};
const dataParaIso=dt=>`${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
const hojeIso=()=>dataParaIso(new Date());
const fmtBR=iso=>iso?isoParaData(iso).toLocaleDateString('pt-BR'):'—';
const nomeMes=m=>['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'][m];
const mesDeIso=iso=>iso.slice(0,7);

function somarMeses(iso,n){
  const[a,m,d]=iso.split('-').map(Number);
  const alvo=new Date(a,m-1+n,1);
  const ud=new Date(alvo.getFullYear(),alvo.getMonth()+1,0).getDate();
  alvo.setDate(Math.min(d,ud));
  return dataParaIso(alvo);
}
function ajustarDiaBase(isoBase,dia){
  if(!dia) return isoBase;
  const d=parseInt(dia,10);if(!d||d<1||d>31) return isoBase;
  const dt=isoParaData(isoBase),ano=dt.getFullYear(),mes=dt.getMonth();
  const udm=new Date(ano,mes+1,0).getDate(),df=Math.min(d,udm);
  let res=`${ano}-${String(mes+1).padStart(2,'0')}-${String(df).padStart(2,'0')}`;
  if(res<isoBase){
    const pm=new Date(ano,mes+1,1),udp=new Date(pm.getFullYear(),pm.getMonth()+1,0).getDate(),dp=Math.min(d,udp);
    res=`${pm.getFullYear()}-${String(pm.getMonth()+1).padStart(2,'0')}-${String(dp).padStart(2,'0')}`;
  }
  return res;
}
function normalizarStatus(s){
  s=String(s||'').toLowerCase().trim();
  if(!s) return'em_aberto';
  if(s==='pago'||s==='recebido'||s==='paid') return'pago';
  if(s==='em_atraso'||s==='atrasado'||s==='atraso') return'em_atraso';
  if(s==='outros'||s==='outro') return'outros';
  return'em_aberto';
}

let ghConfig={owner:'',repo:'pagamentos',branch:'main',pathDividas:'dados/dividas.json',pathReceitas:'dados/receitas.json',token:'',autoSync:true};
function carregarGH(){
  try{
    const raw=localStorage.getItem(CH_GH);
    if(raw) ghConfig={...ghConfig,...JSON.parse(raw)};
    else{
      const rawP=localStorage.getItem(CH_GH_PAG);
      if(rawP){const p=JSON.parse(rawP);ghConfig.owner=p.owner||'';ghConfig.repo=p.repo||'pagamentos';ghConfig.branch=p.branch||'main';ghConfig.token=p.token||''}
    }
  }catch(e){}
}
function salvarGH(){try{localStorage.setItem(CH_GH,JSON.stringify(ghConfig))}catch(e){}}
function ghConfigurado(){return!!(ghConfig.owner&&ghConfig.repo&&ghConfig.token)}
function setStatusSync(txt,tipo){const el=document.getElementById('statusSync');if(el){el.textContent=txt;el.className='status-sync '+(tipo||'')}}
function b64Enc(str){
  const bytes=new TextEncoder().encode(str);const CHUNK=8192;let bin='';
  for(let i=0;i<bytes.length;i+=CHUNK) bin+=String.fromCharCode.apply(null,bytes.subarray(i,Math.min(i+CHUNK,bytes.length)));
  return btoa(bin);
}
function b64Dec(b64){
  const bin=atob(String(b64).replace(/\s/g,''));
  const bytes=new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}
function ghHeaders(type){return{'Authorization':(type==='token'?`token `:`Bearer `)+ghConfig.token,'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'}}
async function fetchGH(url,opts){
  opts=opts||{};
  let r=await fetch(url,{...opts,headers:{...(opts.headers||{}),...ghHeaders('Bearer')}});
  if(r.status===401) r=await fetch(url,{...opts,headers:{...(opts.headers||{}),...ghHeaders('token')}});
  return r;
}
function ghURL(path){return`https://api.github.com/repos/${ghConfig.owner}/${ghConfig.repo}/contents/${path}`}
async function ghRead(path){
  if(!ghConfigurado()) return null;
  try{
    const r=await fetchGH(ghURL(path)+`?ref=${encodeURIComponent(ghConfig.branch)}`,{cache:'no-store'});
    if(r.status===404) return[];
    if(!r.ok) return null;
    const info=await r.json();
    let texto='';
    if(info.content) texto=b64Dec(info.content);
    else if(info.download_url){
      const raw=await fetch(info.download_url,{headers:{'Authorization':`token ${ghConfig.token}`}});
      if(!raw.ok) return null;
      texto=await raw.text();
    } else return null;
    texto=texto.replace(/^\uFEFF/,'').trim();
    if(!texto) return[];
    const arr=JSON.parse(texto);
    return Array.isArray(arr)?arr:null;
  }catch(e){console.error('[GH read]',path,e);return null}
}

function carregarReceitasLocais(){
  try{const raw=localStorage.getItem(CH_RECEITAS);receitas=raw?JSON.parse(raw):[];if(!Array.isArray(receitas))receitas=[]}
  catch(e){receitas=[]}
}
function salvarReceitasLocais(){
  try{localStorage.setItem(CH_RECEITAS,JSON.stringify(receitas));localStorage.setItem(CH_DIRTY,'1')}
  catch(e){console.error('salvar receitas:',e);if(e&&e.name==='QuotaExceededError')alert('⚠️ Armazenamento local cheio.')}
}
function lerDividasLocal(){
  try{const raw=localStorage.getItem(CH_PAGAMENTOS);if(!raw)return null;const arr=JSON.parse(raw);return Array.isArray(arr)?arr:null}
  catch(e){return null}
}
async function carregarTudo(){
  const dirty=localStorage.getItem(CH_DIRTY)==='1';
  carregarReceitasLocais();
  if(ghConfigurado()){
    setStatusSync('☁️ Carregando...','carregando');
    if(!dirty){
      const remoto=await ghRead(ghConfig.pathReceitas);
      if(remoto!==null){receitas=remoto;try{localStorage.setItem(CH_RECEITAS,JSON.stringify(receitas));localStorage.removeItem(CH_DIRTY)}catch(e){}}
    }
  }
  if(ghConfigurado()){
    const desp=await ghRead(ghConfig.pathDividas);
    if(desp!==null){dividasPagamentos=desp;fonteDespesas='github'}
    else{const local=lerDividasLocal();dividasPagamentos=local||[];fonteDespesas=local?'localStorage':'vazio'}
  } else {
    const local=lerDividasLocal();dividasPagamentos=local||[];fonteDespesas=local?'localStorage':'vazio';
  }
  if(ghConfigurado()) setStatusSync(dirty?'⚠️ Local pendente':'✅ Carregado',dirty?'aviso':'ok');
  else setStatusSync('☁️ Offline','');
  manutencaoReceitas();
}
async function recarregarDespesas(){
  if(ghConfigurado()){
    const desp=await ghRead(ghConfig.pathDividas);
    if(desp!==null){dividasPagamentos=desp;fonteDespesas='github';return true}
  }
  const local=lerDividasLocal();
  if(local){dividasPagamentos=local;fonteDespesas='localStorage';return true}
  return false;
}
async function salvarReceitasGitHub(opts){
  opts=opts||{};
  if(!ghConfigurado()||syncing) return false;
  syncing=true;
  try{
    setStatusSync('☁️ Salvando...','salvando');
    const conteudo=JSON.stringify(receitas,null,2);
    if(new Blob([conteudo]).size>LIMITE_GH){setStatusSync('⚠️ Arquivo grande','erro');if(!opts.silencioso) alert('⚠️ O arquivo de receitas excede o limite.');return false}
    let sha=null;
    const getR=await fetchGH(ghURL(ghConfig.pathReceitas)+`?ref=${encodeURIComponent(ghConfig.branch)}`);
    if(getR.ok){const info=await getR.json();sha=info.sha}
    else if(getR.status===404){sha=null}
    else if(getR.status===401){setStatusSync('⚠️ Token inválido','erro');return false}
    else if(getR.status===403){setStatusSync('⚠️ Sem permissão','erro');return false}
    else{setStatusSync('⚠️ Erro ao salvar','erro');return false}
    const body={message:`Receitas — ${new Date().toLocaleString('pt-BR')}`,content:b64Enc(conteudo),branch:ghConfig.branch};
    if(sha) body.sha=sha;
    const putR=await fetchGH(ghURL(ghConfig.pathReceitas),{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    if(!putR.ok){setStatusSync('⚠️ Erro ao salvar','erro');if(!opts.silencioso) alert('❌ Não foi possível salvar no GitHub.');return false}
    localStorage.removeItem(CH_DIRTY);
    setStatusSync(`✅ Salvo ${new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})}`,'ok');
    return true;
  }catch(e){console.error('[GH save]',e);setStatusSync('⚠️ Erro ao salvar','erro');return false}
  finally{syncing=false}
}
function agendarSync(){
  if(!ghConfigurado()||!ghConfig.autoSync) return;
  if(syncTimer) clearTimeout(syncTimer);
  syncTimer=setTimeout(()=>salvarReceitasGitHub({silencioso:true}),2500);
}
function salvar(){salvarReceitasLocais();agendarSync()}

function gerarParcelasAte(r,ateData){
  const base=ajustarDiaBase(r.primeiroVencimento,r.diaVencimento||'');
  const parcelas=[];let cur=base,guard=0;
  while(guard++<1000){
    if(ateData&&cur>ateData) break;
    parcelas.push({id:gid(),vencimento:cur,valor:arr2(r.valorBase),status:'em_aberto'});
    cur=somarMeses(cur,1);
  }
  return parcelas;
}
function manutencaoReceitas(){
  let mudou=false;const hj=hojeIso();
  receitas.forEach(r=>{
    if(!Array.isArray(r.parcelas)) r.parcelas=[];
    if(r.infinita){
      let futuras=r.parcelas.filter(p=>p.vencimento>=hj).length,guard=0;
      while(futuras<PARCELAS_MIN_FUTURAS&&guard++<200){
        const ultima=r.parcelas[r.parcelas.length-1];
        const base=ultima?ultima.vencimento:(r.primeiroVencimento||hj);
        const prox=somarMeses(base,1);
        r.parcelas.push({id:gid(),vencimento:prox,valor:arr2(ultima?ultima.valor:r.valorBase),status:'em_aberto'});
        futuras++;mudou=true;
      }
    } else if(r.dataFim){
      const ultima=r.parcelas[r.parcelas.length-1];
      if(!ultima){r.parcelas=gerarParcelasAte(r,r.dataFim);mudou=true}
      else if(ultima.vencimento<r.dataFim){
        let cur=somarMeses(ultima.vencimento,1),guard=0;
        while(cur<=r.dataFim&&guard++<500){r.parcelas.push({id:gid(),vencimento:cur,valor:arr2(ultima.valor),status:'em_aberto'});cur=somarMeses(cur,1);mudou=true}
      }
    }
  });
  if(mudou) salvarReceitasLocais();
}

function labelStatusReceita(p){
  if(p.status==='recebido') return{classe:'recebido',txt:'✅ Recebido'};
  if(p.vencimento<hojeIso()) return{classe:'atrasado',txt:'⚠️ Atrasada'};
  return{classe:'aberto',txt:'⏳ Em aberto'};
}
function cardReceitaHTML(r,p){
  const st=labelStatusReceita(p);
  const tipo=TIPO_LABEL[r.tipo]||'Outro';
  const podeReceber=p.status!=='recebido';
  return`<div class="item-receita st-${st.classe}" data-receita="${r.id}" data-parcela="${p.id}">
    <div class="item-linha1"><div class="item-info"><div class="fonte">📥 ${esc(r.fonte)}</div><div class="meta">${esc(tipo)} · vence <b>${fmtBR(p.vencimento)}</b> · <span class="selo-status ${st.classe}">${st.txt}</span></div></div>
    <div class="item-valor"><div class="num">${fmtBRL(p.valor)}</div><div class="sublabel">${r.infinita?'∞ contínua':(r.dataFim?'até '+fmtBR(r.dataFim):'')}</div></div></div>
    <div class="item-linha2">${podeReceber?`<button class="btn-acao receber" data-acao="marcarRecebido">✅ Marcar recebido</button>`:`<button class="btn-acao desfazer" data-acao="desmarcarRecebido">↩ Desfazer</button>`}<button class="btn-acao editar" data-acao="editarValor">✏️ Editar valor</button><button class="btn-acao excluir" data-acao="excluirParcela">🗑 Excluir</button></div></div>`;
}
function cardDespesaHTML(d,p){
  const st=normalizarStatus(p.status);
  const map={pago:{c:'pago',t:'✅ Pago'},em_atraso:{c:'atrasado',t:'⚠️ Em atraso'},em_aberto:{c:'aberto',t:'⏳ Em aberto'},outros:{c:'outros',t:'◆ Outros'}};
  const s=map[st]||map.em_aberto;
  const credor=p.credorOverride||d.credor||'Outros';
  const desc=p.descricaoOverride||d.descricao||'';
  return`<div class="item-despesa st-${st}"><div class="info"><div class="fonte">${esc(credor)}</div>${desc?`<div class="meta">${esc(desc)}</div>`:''}<div class="meta">vence ${fmtBR(p.vencimento)} · parcela ${p.numero||'?'}</div></div><div class="valor-area"><div class="valor">${fmtBRL(p.valor)}</div><div class="selo ${s.c}">${s.t}</div></div></div>`;
}
function parcelasReceitaNoMes(mes){
  const out=[];
  receitas.forEach(r=>r.parcelas.forEach(p=>{if(mesDeIso(p.vencimento)===mes)out.push({receita:r,parcela:p})}));
  out.sort((a,b)=>a.parcela.vencimento.localeCompare(b.parcela.vencimento));
  return out;
}
function parcelasDespesaNoMes(mes){
  const out=[];
  dividasPagamentos.forEach(d=>{if(!Array.isArray(d.parcelas))return;d.parcelas.forEach(p=>{if(p.vencimento&&mesDeIso(p.vencimento)===mes)out.push({divida:d,parcela:p})})});
  return out;
}

function renderAvisoVazio(){
  const el=document.getElementById('avisoVazio');if(!el) return;
  const temRec=receitas.length>0,temDesp=dividasPagamentos.length>0;
  if(temRec||temDesp){el.innerHTML='';return}
  if(ghConfigurado()){
    el.innerHTML=`<div class="aviso-vazio"><div class="icon">⚠️</div><div class="body"><b>Nenhuma receita encontrada</b>O GitHub está configurado, mas não há receitas em <code>${esc(ghConfig.pathReceitas)}</code>. <div class="btns"><button id="btnVazioRecarregar">🔄 Recarregar</button></div></div></div>`;
    setTimeout(()=>{const b=document.getElementById('btnVazioRecarregar');if(b)b.addEventListener('click',async()=>{await carregarTudo();renderTelaPrincipal()})},0);
  } else {
    el.innerHTML=`<div class="aviso-vazio"><div class="icon">⚠️</div><div class="body"><b>Nenhum dado neste dispositivo</b>Configure o GitHub ou importe um backup. <div class="btns"><button id="btnVazioConfig">⚙️ Configurar</button><button class="neutro" id="btnVazioImportar">⬆ Importar</button></div></div></div>`;
    setTimeout(()=>{const bc=document.getElementById('btnVazioConfig');if(bc)bc.addEventListener('click',abrirConfig);const bi=document.getElementById('btnVazioImportar');if(bi)bi.addEventListener('click',()=>document.getElementById('arquivoImportarTudo').click())},0);
  }
}
function renderTelaPrincipal(){
  const ano=mesRef.getFullYear(),m=mesRef.getMonth(),mes=`${ano}-${String(m+1).padStart(2,'0')}`;
  document.getElementById('tituloMes').textContent=`${nomeMes(m)} ${ano}`;
  const recs=parcelasReceitaNoMes(mes),dess=parcelasDespesaNoMes(mes);
  let recebido=0,pago=0,aReceber=0,aPagar=0;
  recs.forEach(({parcela})=>{if(parcela.status==='recebido')recebido+=Number(parcela.valor||0);else aReceber+=Number(parcela.valor||0)});
  dess.forEach(({parcela})=>{const st=normalizarStatus(parcela.status);if(st==='pago')pago+=Number(parcela.valor||0);else if(st==='em_aberto'||st==='em_atraso')aPagar+=Number(parcela.valor||0)});
  const saldo=recebido-pago,previsto=(recebido+aReceber)-(pago+aPagar);
  const sEl=document.getElementById('saldoValor');
  sEl.textContent=(saldo>=0?'+ ':'− ')+fmtBRL(Math.abs(saldo));
  sEl.className='valor '+(saldo>=0?'positivo':'negativo');
  const sub=document.getElementById('saldoSubtitulo');
  if(previsto!==saldo) sub.textContent=`Se tudo vencer: ${previsto>=0?'+':'−'} ${fmtBRL(Math.abs(previsto))}`;
  else if(recs.length||dess.length) sub.textContent='Recebido − Pago';
  else sub.textContent='Sem movimentações neste mês';
  document.getElementById('totalRecebido').textContent=fmtBRL(recebido);
  document.getElementById('totalPago').textContent=fmtBRL(pago);
  document.getElementById('totalAReceber').textContent=fmtBRL(aReceber);
  document.getElementById('totalAPagar').textContent=fmtBRL(aPagar);
  document.getElementById('contReceitas').textContent=recs.length;
  document.getElementById('contDespesas').textContent=dess.length;
  const aviso=document.getElementById('avisoFonte');
  if(fonteDespesas==='vazio') aviso.innerHTML=`<div class="aviso-fonte">Sem despesas. Abra o app de pagamentos ou configure o GitHub.</div>`;
  else if(fonteDespesas==='localStorage') aviso.innerHTML=`<div class="aviso-fonte" style="background:linear-gradient(135deg,#eff6ff,#dbeafe);border-color:#93c5fd;border-left-color:var(--marca);color:#1e40af">Despesas do <b>armazenamento local</b>. Configure o GitHub para sincronizar.</div>`;
  else aviso.innerHTML='';
  const cRec=document.getElementById('listaReceitas');
  if(recs.length) cRec.innerHTML=recs.map(({receita,parcela})=>cardReceitaHTML(receita,parcela)).join('');
  else{
    cRec.innerHTML=`<div class="lista-vazia">Nenhuma receita neste mês.<br><br><button class="btn-vazio" id="btnVazioNova">➕ Cadastrar primeira receita</button></div>`;
    const bv=document.getElementById('btnVazioNova');if(bv)bv.addEventListener('click',abrirNovaReceita);
  }
  const cDesp=document.getElementById('listaDespesas');
  if(dess.length){
    dess.sort((a,b)=>String(a.parcela.vencimento).localeCompare(String(b.parcela.vencimento)));
    const totalMes=dess.reduce((s,{parcela})=>s+Number(parcela.valor||0),0);
    cDesp.innerHTML=`<div class="grupo-despesa"><div class="grupo-cabecalho"><span>📤 Despesas do mês</span><span class="grupo-total">${fmtBRL(totalMes)}</span><span class="qtd-badge">${dess.length}x</span></div><div class="itens">${dess.map(({divida,parcela})=>cardDespesaHTML(divida,parcela)).join('')}</div></div>`;
  } else cDesp.innerHTML='<div class="lista-vazia">Nenhuma despesa neste mês.</div>';
  renderAvisoVazio();
  const rv=document.getElementById('rodapeVersao');
  if(rv) rv.textContent=`Fluxo de Caixa v2.0 · ${new Date().toLocaleString('pt-BR',{dateStyle:'short',timeStyle:'short'})}`;
}

function fmtDataColuna(iso){
  const dt=isoParaData(iso),d=String(dt.getDate()).padStart(2,'0');
  return`${d} ${['D','S','T','Q','Q','S','S'][dt.getDay()]}`;
}
function renderDetalheDia(recs,desps){
  let html='';
  recs.forEach(({receita,parcela})=>{
    const st=labelStatusReceita(parcela),tipo=TIPO_LABEL[receita.tipo]||'Outro';
    html+=`<div class="crono-detalhe-item rec"><span class="crono-detalhe-ico">📥</span><div class="crono-detalhe-info"><b>${esc(receita.fonte)}</b><small>${esc(tipo)} · <span class="status-${st.classe}">${st.txt}</span></small></div><span class="crono-detalhe-valor">${fmtBRL(parcela.valor)}</span></div>`;
  });
  desps.forEach(({divida,parcela})=>{
    const st=normalizarStatus(parcela.status);
    const credor=parcela.credorOverride||divida.credor||'—';
    const desc=parcela.descricaoOverride||divida.descricao||'';
    const map={pago:{c:'pago',t:'✅ Pago'},em_atraso:{c:'atrasado',t:'⚠️ Em atraso'},em_aberto:{c:'aberto',t:'⏳ Em aberto'},outros:{c:'outros',t:'◆ Outros'}};
    const s=map[st]||map.em_aberto;
    const meta=desc?`${esc(desc)} · <span class="status-${s.c}">${s.t}</span>`:`<span class="status-${s.c}">${s.t}</span>`;
    html+=`<div class="crono-detalhe-item desp"><span class="crono-detalhe-ico">📤</span><div class="crono-detalhe-info"><b>${esc(credor)}</b><small>${meta}</small></div><span class="crono-detalhe-valor">${fmtBRL(parcela.valor)}</span></div>`;
  });
  return html;
}
function renderCronologico(){
  const ano=mesRef.getFullYear(),m=mesRef.getMonth(),mes=`${ano}-${String(m+1).padStart(2,'0')}`;
  const tEl=document.getElementById('cronoTituloMes');if(tEl) tEl.textContent=`${nomeMes(m)} ${ano}`;
  let acumAnt=0;
  receitas.forEach(r=>r.parcelas.forEach(p=>{if(p.vencimento&&mesDeIso(p.vencimento)<mes)acumAnt+=Number(p.valor||0)}));
  dividasPagamentos.forEach(d=>{if(!Array.isArray(d.parcelas))return;d.parcelas.forEach(p=>{if(p.vencimento&&mesDeIso(p.vencimento)<mes)acumAnt-=Number(p.valor||0)})});
  const diasMap=new Map();
  const garantir=iso=>{if(!diasMap.has(iso))diasMap.set(iso,{receitas:[],despesas:[]});return diasMap.get(iso)};
  receitas.forEach(r=>r.parcelas.forEach(p=>{if(p.vencimento&&mesDeIso(p.vencimento)===mes)garantir(p.vencimento).receitas.push({receita:r,parcela:p})}));
  dividasPagamentos.forEach(d=>{if(!Array.isArray(d.parcelas))return;d.parcelas.forEach(p=>{if(p.vencimento&&mesDeIso(p.vencimento)===mes)garantir(p.vencimento).despesas.push({divida:d,parcela:p})})});
  const dias=Array.from(diasMap.keys()).sort();
  let acum=acumAnt;const linhas=[];let totalRec=0,totalDesp=0,totalSaldo=0;
  dias.forEach(iso=>{
    const dia=diasMap.get(iso);
    const tr=dia.receitas.reduce((s,{parcela})=>s+Number(parcela.valor||0),0);
    const td=dia.despesas.reduce((s,{parcela})=>s+Number(parcela.valor||0),0);
    const saldo=tr-td;acum+=saldo;
    const allOk=dia.receitas.every(({parcela})=>parcela.status==='recebido')&&dia.despesas.every(({parcela})=>normalizarStatus(parcela.status)==='pago')&&(dia.receitas.length+dia.despesas.length>0);
    linhas.push({iso,totalRec:tr,totalDesp:td,saldo,acum,allOk});
    totalRec+=tr;totalDesp+=td;totalSaldo+=saldo;
  });
  const infoEl=document.getElementById('cronoSaldoAnterior');
  if(infoEl) infoEl.innerHTML=`<span>Saldo acumulado até o início do mês<small>Base: todas as movimentações por vencimento</small></span><b class="${acumAnt>=0?'positivo':'negativo'}">${acumAnt>=0?'+':'−'} ${fmtBRL(Math.abs(acumAnt))}</b>`;
  const tbody=document.getElementById('cronoTbody');
  if(!linhas.length){
    tbody.innerHTML=`<tr><td colspan="5" class="crono-vazio">Nenhum movimento neste mês.</td></tr>`;
  } else {
    tbody.innerHTML=linhas.map(l=>{
      const cs=l.saldo>0?'positivo':(l.saldo<0?'negativo':'zero');
      const ca=l.acum>0?'positivo':(l.acum<0?'negativo':'zero');
      const ss=l.saldo>0?'+':(l.saldo<0?'−':'');
      const sa=l.acum>=0?'+':'−';
      const exp=cronoDiasExpandidos.has(l.iso);
      const dia=diasMap.get(l.iso);
      let h=`<tr class="crono-linha${l.allOk?' dia-realizado':''}${exp?' expandido':''}" data-iso="${l.iso}"><td>${fmtDataColuna(l.iso)} <span class="seta-expand">▾</span></td><td class="rec">${l.totalRec>0?fmtBRL(l.totalRec):'—'}</td><td class="desp">${l.totalDesp>0?fmtBRL(l.totalDesp):'—'}</td><td class="saldo ${cs}">${l.saldo!==0?ss+' '+fmtBRL(Math.abs(l.saldo)):'—'}</td><td class="acum ${ca}">${sa} ${fmtBRL(Math.abs(l.acum))}</td></tr>`;
      if(exp) h+=`<tr class="crono-detalhe-row"><td colspan="5"><div class="crono-detalhe">${renderDetalheDia(dia.receitas,dia.despesas)}</div></td></tr>`;
      return h;
    }).join('');
  }
  const tfoot=document.getElementById('cronoTfoot');
  if(linhas.length){
    const csm=totalSaldo>0?'positivo':(totalSaldo<0?'negativo':'');
    const caf=acum>0?'positivo':(acum<0?'negativo':'');
    tfoot.innerHTML=`<tr><td>Total</td><td class="rec">${fmtBRL(totalRec)}</td><td class="desp">${fmtBRL(totalDesp)}</td><td class="saldo ${csm}">${totalSaldo>=0?'+':'−'} ${fmtBRL(Math.abs(totalSaldo))}</td><td class="acum ${caf}">${acum>=0?'+':'−'} ${fmtBRL(Math.abs(acum))}</td></tr>`;
  } else tfoot.innerHTML='';
}

function renderTodasReceitas(){
  const c=document.getElementById('listaTodasReceitas');
  if(!receitas.length){c.innerHTML='<div class="lista-vazia">Nenhuma receita cadastrada.</div>';return}
  c.innerHTML=receitas.map(r=>{
    const receb=r.parcelas.filter(p=>p.status==='recebido');
    const totRec=receb.reduce((s,p)=>s+Number(p.valor||0),0);
    const totPrev=r.parcelas.reduce((s,p)=>s+Number(p.valor||0),0);
    const tipo=TIPO_LABEL[r.tipo]||'Outro';
    const periodo=r.infinita?'∞ contínua':(r.dataFim?`até ${fmtBR(r.dataFim)}`:'—');
    return`<div class="item-receita-completa" data-receita="${r.id}">
      <div class="cabecalho"><div class="titulo-info"><b>${esc(r.fonte)}</b><small>${esc(tipo)} · desde ${fmtBR(r.primeiroVencimento)}</small></div></div>
      <div class="detalhes-grade">
        <div class="det"><span>Valor base</span><strong>${fmtBRL(r.valorBase)}</strong></div>
        <div class="det"><span>Parcelas</span><strong>${r.parcelas.length}</strong></div>
        <div class="det"><span>Recebido</span><strong style="color:var(--verde-esc)">${fmtBRL(totRec)}</strong></div>
        <div class="det"><span>Previsto</span><strong>${fmtBRL(totPrev)}</strong></div>
        <div class="det"><span>Período</span><strong>${periodo}</strong></div>
      </div>
      <div class="rodape"><button class="btn-acao editar" data-acao="editarReceita">✏️ Editar</button><button class="btn-acao excluir" data-acao="excluirReceita">🗑 Excluir</button></div>
    </div>`;
  }).join('');
}

/* GRÁFICOS */
function agregarDados(periodo){
  const hoje=new Date();
  if(periodo==='quinzenal'){
    const ano=mesRef.getFullYear(),m=mesRef.getMonth(),mes=`${ano}-${String(m+1).padStart(2,'0')}`;
    const ultimoDia=new Date(ano,m+1,0).getDate();
    let r1=0,d1=0,r2=0,d2=0;
    receitas.forEach(r=>r.parcelas.forEach(p=>{
      if(!p.vencimento||mesDeIso(p.vencimento)!==mes)return;
      const dia=parseInt(p.vencimento.slice(8),10);
      if(dia<=15) r1+=Number(p.valor||0);else r2+=Number(p.valor||0);
    }));
    dividasPagamentos.forEach(dv=>{
      if(!Array.isArray(dv.parcelas))return;
      dv.parcelas.forEach(p=>{
        if(!p.vencimento||mesDeIso(p.vencimento)!==mes)return;
        const dia=parseInt(p.vencimento.slice(8),10);
        if(dia<=15) d1+=Number(p.valor||0);else d2+=Number(p.valor||0);
      });
    });
    return{labels:['1-15','16-'+ultimoDia],receitas:[arr2(r1),arr2(r2)],despesas:[arr2(d1),arr2(d2)]};
  }
  if(periodo==='mensal'){
    const labels=[],recs=[],dess=[];
    for(let i=11;i>=0;i--){
      const dt=new Date(hoje.getFullYear(),hoje.getMonth()-i,1);
      const mes=`${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}`;
      let r=0,d=0;
      receitas.forEach(rec=>rec.parcelas.forEach(p=>{if(p.vencimento&&mesDeIso(p.vencimento)===mes)r+=Number(p.valor||0)}));
      dividasPagamentos.forEach(dv=>{if(!Array.isArray(dv.parcelas))return;dv.parcelas.forEach(p=>{if(p.vencimento&&mesDeIso(p.vencimento)===mes)d+=Number(p.valor||0)})});
      labels.push(nomeMes(dt.getMonth()).slice(0,3));
      recs.push(arr2(r));dess.push(arr2(d));
    }
    return{labels,receitas:recs,despesas:dess};
  }
  if(periodo==='anual'){
    const labels=[],recs=[],dess=[];
    for(let i=4;i>=0;i--){
      const ano=hoje.getFullYear()-i;
      const anoStr=String(ano);
      let r=0,d=0;
      receitas.forEach(rec=>rec.parcelas.forEach(p=>{if(p.vencimento&&p.vencimento.slice(0,4)===anoStr)r+=Number(p.valor||0)}));
      dividasPagamentos.forEach(dv=>{if(!Array.isArray(dv.parcelas))return;dv.parcelas.forEach(p=>{if(p.vencimento&&p.vencimento.slice(0,4)===anoStr)d+=Number(p.valor||0)})});
      labels.push(anoStr);
      recs.push(arr2(r));dess.push(arr2(d));
    }
    return{labels,receitas:recs,despesas:dess};
  }
  return{labels:[],receitas:[],despesas:[]};
}
function renderGraficos(){
  const dados=agregarDados(graficosPeriodo);
  const totalRec=dados.receitas.reduce((s,v)=>s+v,0);
  const totalDesp=dados.despesas.reduce((s,v)=>s+v,0);
  const saldo=totalRec-totalDesp;
  const resumo=document.getElementById('graficoResumo');
  if(resumo){
    resumo.innerHTML=`
      <div class="res-item res-rec"><span>Receitas</span><strong>${fmtBRL(totalRec)}</strong></div>
      <div class="res-item res-desp"><span>Despesas</span><strong>${fmtBRL(totalDesp)}</strong></div>
      <div class="res-item res-saldo ${saldo>=0?'positivo':'negativo'}"><span>Saldo</span><strong>${saldo>=0?'+':'−'} ${fmtBRL(Math.abs(saldo))}</strong></div>
    `;
  }
  const canvas=document.getElementById('graficoCanvas');
  if(!canvas) return;
  const ctx=canvas.getContext('2d');
  if(graficoAtual){try{graficoAtual.destroy()}catch(e){}graficoAtual=null}
  if(!window.Chart) return;
  const azul='#2563eb',vermelho='#dc2626';
  const azulBg='rgba(37,99,235,.15)',vermelhoBg='rgba(220,38,38,.15)';
  if(graficosTipo==='pizza'){
    graficoAtual=new Chart(ctx,{
      type:'doughnut',
      data:{labels:['Receitas','Despesas'],datasets:[{data:[totalRec,totalDesp],backgroundColor:[azul,vermelho],borderColor:['#fff','#fff'],borderWidth:3}]},
      options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom',labels:{font:{size:12,weight:'bold'},padding:14}},tooltip:{callbacks:{label:c=>c.label+': '+fmtBRL(c.parsed)}}}}
    });
    return;
  }
  if(graficosTipo==='saldo'){
    let acum=0;
    const saldoAcum=dados.receitas.map((r,i)=>{acum+=r-dados.despesas[i];return arr2(acum)});
    graficoAtual=new Chart(ctx,{
      type:'line',
      data:{labels:dados.labels,datasets:[{label:'Saldo acumulado',data:saldoAcum,borderColor:'#16a34a',backgroundColor:'rgba(22,163,74,.15)',fill:true,tension:0.35,pointRadius:4,pointBackgroundColor:'#16a34a',borderWidth:3}]},
      options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom',labels:{font:{size:12,weight:'bold'}}},tooltip:{callbacks:{label:c=>'Saldo: '+fmtBRL(c.parsed.y)}}},scales:{y:{ticks:{callback:v=>fmtBRL(v)}}}}
    });
    return;
  }
  const tipoChart=graficosTipo==='linha'?'line':'bar';
  graficoAtual=new Chart(ctx,{
    type:tipoChart,
    data:{labels:dados.labels,datasets:[
      {label:'Receitas',data:dados.receitas,borderColor:azul,backgroundColor:azulBg,borderWidth:3,tension:0.3,pointRadius:4,pointBackgroundColor:azul,fill:tipoChart==='line'},
      {label:'Despesas',data:dados.despesas,borderColor:vermelho,backgroundColor:vermelhoBg,borderWidth:3,tension:0.3,pointRadius:4,pointBackgroundColor:vermelho,fill:tipoChart==='line'}
    ]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom',labels:{font:{size:12,weight:'bold'},padding:12}},tooltip:{callbacks:{label:c=>c.dataset.label+': '+fmtBRL(c.parsed.y)}}},scales:{y:{ticks:{callback:v=>fmtBRL(v)}}}}
  });
}

/* BACKUP */
function exportarTudo(){
  const b={versao:3,exportadoEm:new Date().toISOString(),receitas,githubConfig:{owner:ghConfig.owner,repo:ghConfig.repo,branch:ghConfig.branch,pathDividas:ghConfig.pathDividas,pathReceitas:ghConfig.pathReceitas,token:ghConfig.token,autoSync:ghConfig.autoSync}};
  const blob=new Blob([JSON.stringify(b,null,2)],{type:'application/json;charset=utf-8'});
  const url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download=`fluxo-backup-${hojeIso()}.json`;a.style.display='none';
  document.body.appendChild(a);a.click();
  setTimeout(()=>{document.body.removeChild(a);URL.revokeObjectURL(url)},1500);
  alert('✅ Backup exportado.\n\n⚠️ Contém seu token GitHub. Guarde em local seguro.');
}
async function importarTudo(file){
  try{
    const dados=JSON.parse(await file.text());
    if(!dados||typeof dados!=='object') throw new Error('Formato inválido');
    const temRec=Array.isArray(dados.receitas),temCfg=dados.githubConfig&&typeof dados.githubConfig==='object';
    if(!temRec&&!temCfg) throw new Error('Nada reconhecido no backup');
    const resumo=[];
    if(temRec) resumo.push(`${dados.receitas.length} receita(s)`);
    if(temCfg&&dados.githubConfig.token) resumo.push('config GitHub');
    if(!confirm(`Importar ${resumo.join(' e ')}?\n\nOs dados atuais serão substituídos.`)) return;
    if(temRec){receitas=dados.receitas;receitas.forEach(r=>{if(!Array.isArray(r.parcelas))r.parcelas=[]});localStorage.setItem(CH_RECEITAS,JSON.stringify(receitas));localStorage.removeItem(CH_DIRTY)}
    if(temCfg){const c=dados.githubConfig;['owner','repo','branch','pathDividas','pathReceitas','token'].forEach(k=>{if(c[k])ghConfig[k]=c[k]});if(typeof c.autoSync==='boolean') ghConfig.autoSync=c.autoSync;salvarGH()}
    if(ghConfigurado()) await recarregarDespesas();
    atualizarConfigUI();
    renderTelaPrincipal();
    alert('✅ Importação concluída.');
  }catch(e){console.error(e);alert('❌ Erro: '+(e.message||'arquivo inválido'))}
}

/* NAVEGAÇÃO */
function mostrarTela(id){
  telaAtual=id;
  ['fluxo','nova','todas','config','cronologico','graficos'].forEach(t=>{
    const el=document.getElementById('tela-'+t);
    if(el) el.classList.toggle('escondido',t!==id);
  });
  window.scrollTo({top:0,behavior:'smooth'});
}
function atualizarConteudoTela(id){
  if(id==='fluxo') renderTelaPrincipal();
  else if(id==='cronologico') renderCronologico();
  else if(id==='todas') renderTodasReceitas();
  else if(id==='config') atualizarConfigUI();
  else if(id==='graficos') renderGraficos();
}
function navegarPara(id){
  if(id===telaAtual){mostrarTela(id);return}
  try{history.pushState({tela:id},'')}catch(e){}
  mostrarTela(id);
}
function tentarSairDoApp(){
  if(window.Capacitor&&window.Capacitor.Plugins&&window.Capacitor.Plugins.App){try{window.Capacitor.Plugins.App.exitApp();return}catch(e){}}
  if(navigator.app&&typeof navigator.app.exitApp==='function'){try{navigator.app.exitApp();return}catch(e){}}
  if(window.Android&&typeof window.Android.exitApp==='function'){try{window.Android.exitApp();return}catch(e){}}
  if(window.AndroidBridge&&typeof window.AndroidBridge.exitApp==='function'){try{window.AndroidBridge.exitApp();return}catch(e){}}
}
function voltarTela(){if(telaAtual!=='fluxo') history.back();else tentarSairDoApp()}
(function navHistorico(){
  try{history.replaceState({tela:'fluxo'},'')}catch(e){}
  window.addEventListener('popstate',e=>{const t=(e&&e.state&&e.state.tela)||'fluxo';mostrarTela(t);atualizarConteudoTela(t)});
  if(window.Capacitor&&window.Capacitor.Plugins&&window.Capacitor.Plugins.App){
    try{window.Capacitor.Plugins.App.addListener('backButton',()=>{if(telaAtual!=='fluxo')history.back();else window.Capacitor.Plugins.App.exitApp()})}catch(e){}
  }
  document.addEventListener('backbutton',e=>{e.preventDefault();if(telaAtual!=='fluxo')history.back();else tentarSairDoApp()},false);
})();

/* FORMULÁRIO */
const formReceita=document.getElementById('formReceita');
const campoFonte=document.getElementById('campoFonte');
const campoTipo=document.getElementById('campoTipo');
const campoValorBase=document.getElementById('campoValorBase');
const campoPrimeiro=document.getElementById('campoPrimeiro');
const campoDiaVenc=document.getElementById('campoDiaVenc');
const campoInfinita=document.getElementById('campoInfinita');
const campoDataFim=document.getElementById('campoDataFim');
const labelInfinita=document.getElementById('labelInfinita');
const blocoDataFim=document.getElementById('blocoDataFim');
const tituloForm=document.getElementById('tituloForm');

(function(){for(let i=1;i<=31;i++){const o=document.createElement('option');o.value=i;o.textContent=`Dia ${i}`;campoDiaVenc.appendChild(o)}})();
function alternarInfinita(){
  const inf=campoInfinita.checked;
  labelInfinita.classList.toggle('ativo',inf);
  blocoDataFim.classList.toggle('escondido',inf);
  if(inf) campoDataFim.removeAttribute('required');
  else campoDataFim.setAttribute('required','');
}
campoInfinita.addEventListener('change',alternarInfinita);
function limparForm(){formReceita.reset();campoInfinita.checked=false;campoDiaVenc.value='';alternarInfinita();campoPrimeiro.value=hojeIso()}
function abrirNovaReceita(){
  editandoId=null;limparForm();
  tituloForm.innerHTML='➕ Nova receita';
  document.getElementById('btnSalvarForm').innerHTML='💾 Salvar';
  navegarPara('nova');
  setTimeout(()=>campoFonte.focus(),200);
}
function abrirEdicaoReceita(id){
  const r=receitas.find(x=>x.id===id);if(!r) return;
  editandoId=id;limparForm();
  campoFonte.value=r.fonte||'';
  campoTipo.value=r.tipo||'aluguel';
  campoValorBase.value=r.valorBase||'';
  campoPrimeiro.value=r.primeiroVencimento||hojeIso();
  campoDiaVenc.value=r.diaVencimento||'';
  campoInfinita.checked=!!r.infinita;
  campoDataFim.value=r.dataFim||'';
  alternarInfinita();
  tituloForm.innerHTML='✏️ Editar receita';
  document.getElementById('btnSalvarForm').innerHTML='💾 Salvar alterações';
  navegarPara('nova');
  setTimeout(()=>campoFonte.focus(),200);
}
formReceita.addEventListener('submit',e=>{
  e.preventDefault();
  const fonte=campoFonte.value.trim(),tipo=campoTipo.value;
  const valorBase=arr2(parseFloat(campoValorBase.value));
  const primeiro=campoPrimeiro.value,diaVenc=campoDiaVenc.value;
  const infinita=campoInfinita.checked,dataFim=infinita?null:campoDataFim.value;
  if(!fonte){alert('Informe a fonte.');campoFonte.focus();return}
  if(!valorBase||valorBase<=0){alert('Valor inválido.');campoValorBase.focus();return}
  if(!primeiro){alert('Informe o 1º vencimento.');campoPrimeiro.focus();return}
  if(!infinita&&!dataFim){alert('Informe data fim (ou marque infinita).');campoDataFim.focus();return}
  if(!infinita&&dataFim<primeiro){alert('Data fim deve ser posterior.');campoDataFim.focus();return}
  const base=ajustarDiaBase(primeiro,diaVenc);
  if(editandoId){
    const r=receitas.find(x=>x.id===editandoId);if(!r) return;
    r.fonte=fonte;r.tipo=tipo;r.diaVencimento=diaVenc;r.infinita=infinita;r.dataFim=dataFim;
    if(!infinita){
      r.parcelas=r.parcelas.filter(p=>p.status==='recebido'||p.vencimento<=dataFim);
      const ult=r.parcelas.filter(p=>p.status==='recebido'||p.vencimento<=dataFim).sort((a,b)=>a.vencimento.localeCompare(b.vencimento)).pop();
      if(ult&&ult.vencimento<dataFim){
        let cur=somarMeses(ult.vencimento,1),guard=0;
        while(cur<=dataFim&&guard++<500){r.parcelas.push({id:gid(),vencimento:cur,valor:arr2(r.valorBase),status:'em_aberto'});cur=somarMeses(cur,1)}
      }
    }
    r.parcelas.sort((a,b)=>a.vencimento.localeCompare(b.vencimento));
    salvar();voltarTela();return;
  }
  const nova={id:gid(),fonte,tipo,valorBase,primeiroVencimento:base,diaVencimento:diaVenc,infinita,dataFim:infinita?null:dataFim,criadoEm:new Date().toISOString(),parcelas:[]};
  if(infinita){
    let cur=base;
    for(let i=0;i<PARCELAS_INICIAIS;i++){nova.parcelas.push({id:gid(),vencimento:cur,valor:arr2(valorBase),status:'em_aberto'});cur=somarMeses(cur,1)}
  } else {
    let cur=base,guard=0;
    while(cur<=dataFim&&guard++<500){nova.parcelas.push({id:gid(),vencimento:cur,valor:arr2(valorBase),status:'em_aberto'});cur=somarMeses(cur,1)}
  }
  receitas.push(nova);salvar();
  const dt=isoParaData(base);
  mesRef=new Date(dt.getFullYear(),dt.getMonth(),1);
  voltarTela();
});
document.getElementById('btnDescartar').addEventListener('click',()=>{if(confirm('Descartar?'))voltarTela()});
document.getElementById('voltarForm').addEventListener('click',()=>{if(confirm('Voltar?'))voltarTela()});

/* AÇÕES RECEITAS */
document.getElementById('listaReceitas').addEventListener('click',async e=>{
  const b=e.target.closest('[data-acao]');if(!b) return;
  const card=b.closest('[data-receita]');if(!card) return;
  const r=receitas.find(x=>x.id===card.dataset.receita);if(!r) return;
  const p=r.parcelas.find(x=>x.id===card.dataset.parcela);if(!p) return;
  const a=b.dataset.acao;
  if(a==='marcarRecebido'){p.status='recebido';salvar();renderTelaPrincipal();return}
  if(a==='desmarcarRecebido'){if(!confirm('Desfazer o recebimento?'))return;p.status='em_aberto';salvar();renderTelaPrincipal();return}
  if(a==='editarValor'){abrirEdicaoValor(r,p);return}
  if(a==='excluirParcela'){
    const sc=await perguntarEscopo(r,p,{},'excluir');
    if(sc==='cancelar') return;
    aplicarExclusao(r,p,sc);salvar();renderTelaPrincipal();return;
  }
});
function abrirEdicaoValor(r,p){
  edicaoValorPendente={receita:r,parcela:p};
  document.getElementById('infoEdicaoValor').innerHTML=`<b>${esc(r.fonte)}</b><br>Parcela de <b>${fmtBR(p.vencimento)}</b> · valor atual: <b>${fmtBRL(p.valor)}</b>`;
  document.getElementById('inputNovoValor').value=Number(p.valor).toFixed(2);
  document.getElementById('modalEditarValor').classList.remove('escondido');
  setTimeout(()=>{const inp=document.getElementById('inputNovoValor');inp.focus();inp.select()},100);
}
function fecharModalEdicaoValor(){
  document.getElementById('modalEditarValor').classList.add('escondido');
  edicaoValorPendente=null;
}
document.getElementById('btnCancelarValor').addEventListener('click',fecharModalEdicaoValor);
document.getElementById('modalEditarValor').addEventListener('click',e=>{if(e.target.id==='modalEditarValor')fecharModalEdicaoValor()});
document.getElementById('btnAplicarValor').addEventListener('click',async()=>{
  if(!edicaoValorPendente) return;
  const inp=document.getElementById('inputNovoValor');
  const v=arr2(parseFloat(String(inp.value).replace(',','.')));
  if(!v||v<=0){alert('Valor inválido.');inp.focus();return}
  const{receita:r,parcela:p}=edicaoValorPendente;
  if(v===Number(p.valor)){fecharModalEdicaoValor();return}
  fecharModalEdicaoValor();
  const sc=await perguntarEscopo(r,p,{valor:v});
  if(sc==='cancelar') return;
  aplicarMudancaValor(r,p,v,sc);salvar();renderTelaPrincipal();
});
document.getElementById('inputNovoValor').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();document.getElementById('btnAplicarValor').click()}});
function aplicarMudancaValor(r,p,novo,sc){
  calcularAfetadas(r,p,sc).forEach(x=>{x.valor=arr2(novo)});
  if(sc==='futuras'||sc==='todas') r.valorBase=arr2(novo);
}
function aplicarExclusao(r,p,sc){
  if(sc==='todas') receitas=receitas.filter(x=>x.id!==r.id);
  else if(sc==='futuras'){
    r.parcelas=r.parcelas.filter(x=>x.vencimento<p.vencimento||x.status==='recebido');
    if(!r.parcelas.length) receitas=receitas.filter(x=>x.id!==r.id);
  } else {
    r.parcelas=r.parcelas.filter(x=>x.id!==p.id);
    if(!r.parcelas.length) receitas=receitas.filter(x=>x.id!==r.id);
  }
}
function calcularAfetadas(r,p,sc){
  if(sc==='apenas') return[p];
  if(sc==='todas') return r.parcelas.slice();
  if(sc==='futuras') return r.parcelas.filter(x=>x.vencimento>=p.vencimento);
  return[p];
}
function perguntarEscopo(r,p,mud,modo){
  modo=modo||'aplicar';
  return new Promise(resolve=>{
    resolverEscopo=resolve;
    document.getElementById('escopoEmoji').textContent=modo==='excluir'?'🗑':'🎯';
    document.getElementById('escopoTitulo').textContent=modo==='excluir'?'O que excluir?':'Onde aplicar?';
    if(modo==='excluir'){
      document.getElementById('textoEscopo').innerHTML=`Parcela de <b>${fmtBR(p.vencimento)}</b> · <b>${fmtBRL(p.valor)}</b><br>Receita: <b>${esc(r.fonte)}</b><br><br>Escolha o alcance:`;
      document.getElementById('subApenas').textContent='Exclui apenas esta parcela';
      document.getElementById('subFuturas').textContent='Exclui esta e posteriores';
      document.getElementById('subTodas').textContent='Exclui todas as parcelas';
    } else {
      document.getElementById('textoEscopo').innerHTML=`Parcela de <b>${fmtBR(p.vencimento)}</b> · atual <b>${fmtBRL(p.valor)}</b><br>Receita: <b>${esc(r.fonte)}</b><br><br>Novo valor: <b>${fmtBRL(mud.valor)}</b><br><br>Aplicar a:`;
      document.getElementById('subApenas').textContent='Altera apenas esta';
      document.getElementById('subFuturas').textContent='Altera esta e posteriores (reajuste)';
      document.getElementById('subTodas').textContent='Altera todas (inclusive recebidas)';
    }
    document.getElementById('modalEscopo').classList.remove('escondido');
  });
}
document.getElementById('modalEscopo').addEventListener('click',e=>{
  const b=e.target.closest('[data-escopo]');
  if(!b){
    if(e.target.id==='modalEscopo'&&resolverEscopo){document.getElementById('modalEscopo').classList.add('escondido');resolverEscopo('cancelar');resolverEscopo=null}
    return;
  }
  document.getElementById('modalEscopo').classList.add('escondido');
  if(resolverEscopo){resolverEscopo(b.dataset.escopo);resolverEscopo=null}
});
document.getElementById('listaTodasReceitas').addEventListener('click',e=>{
  const b=e.target.closest('[data-acao]');if(!b) return;
  const card=b.closest('[data-receita]');if(!card) return;
  const r=receitas.find(x=>x.id===card.dataset.receita);if(!r) return;
  if(b.dataset.acao==='editarReceita'){abrirEdicaoReceita(r.id);return}
  if(b.dataset.acao==='excluirReceita'){
    if(!confirm(`Excluir "${r.fonte}" e as ${r.parcelas.length} parcelas?`)) return;
    receitas=receitas.filter(x=>x.id!==r.id);
    salvar();renderTodasReceitas();
  }
});

/* MÊS — botões ‹ › */
function animarWrapperFlash(wrapper){
  if(!wrapper||typeof wrapper.animate!=='function') return;
  requestAnimationFrame(()=>{
    try{wrapper.animate([{opacity:0.4,transform:'translateY(4px)'},{opacity:1,transform:'translateY(0)'}],{duration:200,easing:'ease-out'})}catch(e){}
  });
}
function mudarMes(delta){
  mesRef=new Date(mesRef.getFullYear(),mesRef.getMonth()+delta,1);
  try{localStorage.setItem(CH_MES,mesRef.toISOString().slice(0,10))}catch(e){}
  renderTelaPrincipal();
  animarWrapperFlash(document.getElementById('swc-fluxo'));
}
document.getElementById('mesAnterior').addEventListener('click',()=>mudarMes(-1));
document.getElementById('mesProximo').addEventListener('click',()=>mudarMes(1));
function mudarMesCrono(delta){
  mesRef=new Date(mesRef.getFullYear(),mesRef.getMonth()+delta,1);
  try{localStorage.setItem(CH_MES,mesRef.toISOString().slice(0,10))}catch(e){}
  cronoDiasExpandidos.clear();
  renderCronologico();
  animarWrapperFlash(document.getElementById('swc-cronologico'));
}
document.getElementById('cronoMesAnterior').addEventListener('click',()=>mudarMesCrono(-1));
document.getElementById('cronoMesProximo').addEventListener('click',()=>mudarMesCrono(1));

/* ========== SWIPE (NOVA LÓGICA — anima o wrapper) ========== */
/* ========== SWIPE (gatilho restrito aos quadros de saldo) ========== */
/* ========== SWIPE (gatilho restrito aos quadros de saldo) ========== */
/* ========== SWIPE (gatilho restrito: card-saldo + listas / crono-info) ========== */
function configurarSwipe(){
  const telas=[
    {
      alvos:[
        document.querySelector('#tela-fluxo .card-saldo'),
        document.getElementById('listaReceitas'),
        document.getElementById('listaDespesas')
      ],
      wrapper:document.getElementById('swc-fluxo'),
      isCrono:false
    },
    {
      alvos:[
        document.querySelector('#tela-cronologico .crono-info')
      ],
      wrapper:document.getElementById('swc-cronologico'),
      isCrono:true
    }
  ];
  telas.forEach(({alvos,wrapper,isCrono})=>{
    const alvosValidos=(alvos||[]).filter(Boolean);
    if(!alvosValidos.length||!wrapper) return;
    let sx=0,sy=0,tracking=false,horizontal=false,dir=0,animando=false;
    let cacheProximo=null,cacheAnterior=null,cacheMes=null,gerandoCache=false;
    let overlay=null,curPane=null,nextPane=null;

    function limparOverlay(){
      document.querySelectorAll('.swipe-overlay-temp').forEach(o=>o.remove());
      overlay=null;curPane=null;nextPane=null;
      if(wrapper) wrapper.style.visibility='';
    }

    function gerarCache(){
      if(gerandoCache) return;
      if(cacheMes===mesRef.getTime()&&cacheProximo&&cacheAnterior) return;
      gerandoCache=true;
      const mesOriginal=new Date(mesRef);
      const tituloEl=document.getElementById(isCrono?'cronoTituloMes':'tituloMes');
      const tituloOriginal=tituloEl?tituloEl.textContent:'';
      const scrollY=window.scrollY;
      const visAnt=wrapper.style.visibility;
      const savedChildren=Array.from(wrapper.childNodes);
      const htmlOriginal=wrapper.innerHTML;
      wrapper.style.visibility='hidden';
      try{
        wrapper.innerHTML=htmlOriginal;
        mesRef=new Date(mesOriginal.getFullYear(),mesOriginal.getMonth()+1,1);
        if(isCrono) renderCronologico(); else renderTelaPrincipal();
        cacheProximo=wrapper.innerHTML;
        wrapper.innerHTML=htmlOriginal;
        mesRef=new Date(mesOriginal.getFullYear(),mesOriginal.getMonth()-1,1);
        if(isCrono) renderCronologico(); else renderTelaPrincipal();
        cacheAnterior=wrapper.innerHTML;
        cacheMes=mesOriginal.getTime();
      }catch(e){console.error('cache:',e)}
      finally{
        mesRef=mesOriginal;
        while(wrapper.firstChild) wrapper.removeChild(wrapper.firstChild);
        savedChildren.forEach(n=>wrapper.appendChild(n));
        if(tituloEl) tituloEl.textContent=tituloOriginal;
        window.scrollTo(0,scrollY);
        wrapper.style.visibility=visAnt;
        gerandoCache=false;
      }
    }

    function criarOverlay(){
      if(cacheMes!==mesRef.getTime()||!cacheProximo||!cacheAnterior){
        gerarCache();
      }
      const html=dir>0?cacheProximo:cacheAnterior;
      if(!html) return false;
      const rect=wrapper.getBoundingClientRect();
      const w=rect.width,h=rect.height;
      overlay=document.createElement('div');
      overlay.className='swipe-overlay-temp';
      overlay.style.cssText=`position:fixed;top:${rect.top}px;left:${rect.left}px;width:${w}px;height:${h}px;overflow:hidden;z-index:99999;pointer-events:none;`;
      curPane=wrapper.cloneNode(true);
      curPane.removeAttribute('id');
      curPane.querySelectorAll('[id]').forEach(el=>el.removeAttribute('id'));
      curPane.style.cssText='position:absolute;top:0;left:0;width:100%;height:100%;overflow:hidden;will-change:transform;transform:translateX(0);';
      nextPane=document.createElement('div');
      nextPane.style.cssText=`position:absolute;top:0;left:0;width:100%;height:100%;overflow:hidden;will-change:transform;transform:translateX(${dir>0?w:-w}px);`;
      nextPane.innerHTML=html;
      nextPane.querySelectorAll('[id]').forEach(el=>el.removeAttribute('id'));
      overlay.appendChild(curPane);
      overlay.appendChild(nextPane);
      document.body.appendChild(overlay);
      wrapper.style.visibility='hidden';
      return true;
    }

    function animarOverlay(dxInicial,concluir,w){
      const mesRefSnapshot=mesRef.getTime();
      const startCur=dxInicial;
      const startNext=(dir>0?w:-w)+dxInicial;
      const endCur=concluir?(dir>0?-w:w):0;
      const endNext=concluir?0:(dir>0?w:-w);
      const dur=200;
      const startT=performance.now();
      function frame(now){
        if(!curPane||!nextPane){animando=false;return}
        const p=Math.min((now-startT)/dur,1);
        const ease=p<0.5?4*p*p*p:1-Math.pow(-2*p+2,3)/2;
        curPane.style.transform=`translateX(${startCur+(endCur-startCur)*ease}px)`;
        nextPane.style.transform=`translateX(${startNext+(endNext-startNext)*ease}px)`;
        if(p<1){requestAnimationFrame(frame);return}
        if(concluir){
          if(mesRef.getTime()!==mesRefSnapshot){
            limparOverlay();animando=false;return;
          }
          mesRef=new Date(mesRef.getFullYear(),mesRef.getMonth()+dir,1);
          try{localStorage.setItem(CH_MES,mesRef.toISOString().slice(0,10))}catch(e){}
          cacheMes=null;
          if(isCrono){cronoDiasExpandidos.clear();renderCronologico()}else renderTelaPrincipal();
          requestAnimationFrame(()=>{limparOverlay();animando=false;setTimeout(gerarCache,150)});
        } else {limparOverlay();animando=false}
      }
      requestAnimationFrame(frame);
    }

    function animarWrapper(dxInicial,concluir,w){
      const mesRefSnapshot=mesRef.getTime();
      const endX=concluir?(dir>0?-w:w):0;
      const dur=180;
      const startT=performance.now();
      wrapper.style.transition='none';
      function frame(now){
        const p=Math.min((now-startT)/dur,1);
        const ease=p<0.5?4*p*p*p:1-Math.pow(-2*p+2,3)/2;
        wrapper.style.transform=`translateX(${dxInicial+(endX-dxInicial)*ease}px)`;
        if(p<1){requestAnimationFrame(frame);return}
        if(concluir){
          if(mesRef.getTime()!==mesRefSnapshot){
            wrapper.style.transform='';wrapper.style.transition='';animando=false;return;
          }
          mesRef=new Date(mesRef.getFullYear(),mesRef.getMonth()+dir,1);
          try{localStorage.setItem(CH_MES,mesRef.toISOString().slice(0,10))}catch(e){}
          cacheMes=null;
          if(isCrono){cronoDiasExpandidos.clear();renderCronologico()}else renderTelaPrincipal();
          const startX2=dir>0?w:-w;
          wrapper.style.transform=`translateX(${startX2}px)`;
          void wrapper.offsetWidth;
          const startT2=performance.now();
          function frame2(now2){
            const p2=Math.min((now2-startT2)/dur,1);
            const ease2=p2<0.5?4*p2*p2*p2:1-Math.pow(-2*p2+2,3)/2;
            wrapper.style.transform=`translateX(${startX2+(0-startX2)*ease2}px)`;
            if(p2<1){requestAnimationFrame(frame2);return}
            wrapper.style.transform='';wrapper.style.transition='';
            animando=false;
            setTimeout(gerarCache,150);
          }
          requestAnimationFrame(frame2);
        } else {
          wrapper.style.transform='';wrapper.style.transition='';
          animando=false;
        }
      }
      requestAnimationFrame(frame);
    }

    /* ⬇️ anexa os mesmos handlers a TODOS os alvos deste grupo */
    alvosValidos.forEach(alvo=>{
      alvo.style.touchAction='pan-y';

      alvo.addEventListener('touchstart',e=>{
        animando=false;
        limparOverlay();
        const t=e.touches[0];sx=t.clientX;sy=t.clientY;
        tracking=true;horizontal=false;dir=0;
        wrapper.style.transition='none';
        wrapper.style.transform='';
        setTimeout(()=>{if(!horizontal) gerarCache()},0);
      },{passive:true});

      alvo.addEventListener('touchmove',e=>{
        if(!tracking) return;
        const t=e.touches[0];const dx=t.clientX-sx,dy=t.clientY-sy;
        const adx=Math.abs(dx),ady=Math.abs(dy);
        if(!horizontal){
          if(adx>ady&&adx>5){
            horizontal=true;dir=dx<0?1:-1;
            if(!criarOverlay()){
              gerarCache();
              criarOverlay();
            }
          } else if(ady>adx&&ady>10){
            tracking=false;
            wrapper.style.transition='';
            wrapper.style.transform='';
            return;
          } else return;
        }
        if(e.cancelable) e.preventDefault();
        if(overlay&&curPane&&nextPane){
          const w=wrapper.getBoundingClientRect().width||window.innerWidth;
          curPane.style.transform=`translateX(${dx}px)`;
          nextPane.style.transform=`translateX(${(dir>0?w:-w)+dx}px)`;
        } else {
          wrapper.style.transform=`translateX(${dx}px)`;
        }
      },{passive:false});

      alvo.addEventListener('touchend',e=>{
        if(!tracking) return;
        tracking=false;
        if(!horizontal){limparOverlay();return}
        const t=e.changedTouches[0];const dx=t.clientX-sx;
        const dirOk=Math.sign(dx)===-dir;
        const w=window.innerWidth;
        const concluir=dirOk&&Math.abs(dx)>25;
        if(overlay&&curPane&&nextPane) animarOverlay(dx,concluir,w);
        else animarWrapper(dx,concluir,w);
      },{passive:true});

      alvo.addEventListener('touchcancel',()=>{
        tracking=false;limparOverlay();
        wrapper.style.transition='';
        wrapper.style.transform='';
      },{passive:true});
    });
  });
}
configurarSwipe();

document.getElementById('cronoTbody').addEventListener('click',e=>{
  const tr=e.target.closest('.crono-linha');if(!tr) return;
  const iso=tr.dataset.iso;if(!iso) return;
  if(cronoDiasExpandidos.has(iso)) cronoDiasExpandidos.delete(iso);
  else cronoDiasExpandidos.add(iso);
  renderCronologico();
});
document.getElementById('btnNovaReceita').addEventListener('click',abrirNovaReceita);
document.getElementById('btnNovaReceita2').addEventListener('click',abrirNovaReceita);
document.getElementById('btnTodasReceitas').addEventListener('click',()=>{renderTodasReceitas();navegarPara('todas')});
document.getElementById('btnCronologico').addEventListener('click',()=>{renderCronologico();navegarPara('cronologico')});
document.getElementById('btnGraficos').addEventListener('click',()=>{renderGraficos();navegarPara('graficos')});
document.getElementById('voltarTodas').addEventListener('click',voltarTela);
document.getElementById('voltarCronologico').addEventListener('click',voltarTela);
document.getElementById('voltarGraficos').addEventListener('click',voltarTela);

document.getElementById('tabsPeriodo').addEventListener('click',e=>{
  const btn=e.target.closest('[data-periodo]');if(!btn) return;
  graficosPeriodo=btn.dataset.periodo;
  document.querySelectorAll('#tabsPeriodo .grafico-tab').forEach(t=>t.classList.toggle('ativo',t===btn));
  renderGraficos();
});
document.getElementById('tabsTipo').addEventListener('click',e=>{
  const btn=e.target.closest('[data-tipo]');if(!btn) return;
  graficosTipo=btn.dataset.tipo;
  document.querySelectorAll('#tabsTipo .grafico-tab').forEach(t=>t.classList.toggle('ativo',t===btn));
  renderGraficos();
});

const elOwner=document.getElementById('ghOwner');
const elRepo=document.getElementById('ghRepo');
const elBranch=document.getElementById('ghBranch');
const elPathD=document.getElementById('ghPathDividas');
const elPathR=document.getElementById('ghPathReceitas');
const elToken=document.getElementById('ghToken');
const elAuto=document.getElementById('ghAutoSync');
function atualizarConfigUI(){
  elOwner.value=ghConfig.owner||'';
  elRepo.value=ghConfig.repo||'pagamentos';
  elBranch.value=ghConfig.branch||'main';
  elPathD.value=ghConfig.pathDividas||'dados/dividas.json';
  elPathR.value=ghConfig.pathReceitas||'dados/receitas.json';
  elToken.value=ghConfig.token||'';
  elAuto.checked=!!ghConfig.autoSync;
  const st=document.getElementById('configStatus');
  if(ghConfigurado()){
    st.className='config-status ok';
    st.querySelector('.emoji').textContent='✅';
    document.getElementById('configStatusTitulo').textContent='Configurado';
    document.getElementById('configStatusDescricao').textContent=`${ghConfig.owner}/${ghConfig.repo} — ${ghConfig.pathReceitas}`;
  } else {
    st.className='config-status aviso';
    st.querySelector('.emoji').textContent='⚠️';
    document.getElementById('configStatusTitulo').textContent='Não configurado';
    document.getElementById('configStatusDescricao').textContent='Sem sincronização — leitura local apenas.';
  }
}
function abrirConfig(){atualizarConfigUI();navegarPara('config')}
document.getElementById('btnConfig').addEventListener('click',abrirConfig);
document.getElementById('voltarConfig').addEventListener('click',voltarTela);
document.getElementById('btnSalvarConfig').addEventListener('click',async()=>{
  const ow=elOwner.value.trim(),rp=elRepo.value.trim()||'pagamentos',br=elBranch.value.trim()||'main';
  const pd=elPathD.value.trim()||'dados/dividas.json',pr=elPathR.value.trim()||'dados/receitas.json',tk=elToken.value.trim();
  if(!ow){alert('Informe usuário GitHub.');elOwner.focus();return}
  if(!tk){alert('Informe token.');elToken.focus();return}
  Object.assign(ghConfig,{owner:ow,repo:rp,branch:br,pathDividas:pd,pathReceitas:pr,token:tk,autoSync:elAuto.checked});
  salvarGH();atualizarConfigUI();setStatusSync('☁️ Configurado','ok');
  const btn=document.getElementById('btnSalvarConfig'),orig=btn.textContent;
  btn.textContent='⏳ Sincronizando...';btn.disabled=true;
  try{
    const remoto=await ghRead(ghConfig.pathReceitas);
    const temLocal=receitas.length>0;
    if(remoto!==null&&remoto.length>0){
      if(temLocal&&remoto.length!==receitas.length){
        const usarR=confirm(`GitHub: ${remoto.length} receita(s)\nLocal: ${receitas.length}\n\n[OK] Carregar do GitHub\n[Cancelar] Enviar local`);
        if(usarR){receitas=remoto;localStorage.setItem(CH_RECEITAS,JSON.stringify(receitas));localStorage.removeItem(CH_DIRTY)}
        else await salvarReceitasGitHub({silencioso:true});
      } else {receitas=remoto;localStorage.setItem(CH_RECEITAS,JSON.stringify(receitas));localStorage.removeItem(CH_DIRTY)}
    } else if(remoto!==null&&remoto.length===0&&temLocal){await salvarReceitasGitHub({silencioso:true})}
    await recarregarDespesas();
    renderTelaPrincipal();
    alert('✅ Configuração salva e sincronizada.');
  }catch(e){console.error(e);alert('❌ Erro: '+(e.message||'verifique a conexão'))}
  finally{btn.textContent=orig;btn.disabled=false}
});
document.getElementById('btnTestar').addEventListener('click',async()=>{
  const ow=elOwner.value.trim(),rp=elRepo.value.trim(),tk=elToken.value.trim();
  const br=elBranch.value.trim()||'main',pd=elPathD.value.trim()||'dados/dividas.json',pr=elPathR.value.trim()||'dados/receitas.json';
  if(!ow||!rp||!tk){alert('Preencha usuário, repositório e token.');return}
  const btn=document.getElementById('btnTestar'),orig=btn.textContent;
  btn.textContent='⏳ Testando...';btn.disabled=true;
  try{
    const r=await fetch(`https://api.github.com/repos/${ow}/${rp}`,{headers:{'Authorization':`Bearer ${tk}`,'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'}});
    if(!r.ok){alert(r.status===401?'❌ Token inválido.':r.status===404?'❌ Repositório não encontrado.':'❌ Erro '+r.status);return}
    const info=await r.json();
    let msg=`✅ ${info.full_name}\nPush: ${info.permissions?.push?'SIM':'NÃO'}\n\n`;
    const rd=await fetch(`https://api.github.com/repos/${ow}/${rp}/contents/${pd}?ref=${br}`,{headers:{'Authorization':`Bearer ${tk}`,'Accept':'application/vnd.github+json'}});
    msg+=rd.status===200?`📄 ${pd} existe\n`:`📄 ${pd} ainda não existe\n`;
    const rr=await fetch(`https://api.github.com/repos/${ow}/${rp}/contents/${pr}?ref=${br}`,{headers:{'Authorization':`Bearer ${tk}`,'Accept':'application/vnd.github+json'}});
    msg+=rr.status===200?`📄 ${pr} existe`:`📄 ${pr} ainda não existe`;
    alert(msg);
  }catch(e){alert('❌ Rede: '+e.message)}
  finally{btn.textContent=orig;btn.disabled=false}
});
document.getElementById('btnRecarregarDespesas').addEventListener('click',async()=>{
  const btn=document.getElementById('btnRecarregarDespesas'),orig=btn.textContent;
  btn.textContent='⏳ Recarregando...';btn.disabled=true;
  try{const ok=await recarregarDespesas();renderTelaPrincipal();if(!ok) alert('Não foi possível recarregar.')}
  finally{btn.textContent=orig;btn.disabled=false}
});
document.getElementById('btnExportarTudo').addEventListener('click',exportarTudo);
document.getElementById('btnImportarTudo').addEventListener('click',()=>document.getElementById('arquivoImportarTudo').click());
document.getElementById('arquivoImportarTudo').addEventListener('change',async e=>{
  const f=e.target.files&&e.target.files[0];if(!f) return;
  await importarTudo(f);e.target.value='';
});

(async function init(){
  carregarGH();
  try{
    const raw=localStorage.getItem(CH_MES);
    if(raw){const d=isoParaData(raw);if(!isNaN(d.getTime()))mesRef=new Date(d.getFullYear(),d.getMonth(),1)}
  }catch(e){}
  await carregarTudo();
  atualizarConfigUI();
  renderTelaPrincipal();
  if(localStorage.getItem(CH_DIRTY)==='1'&&ghConfigurado()) salvarReceitasGitHub({silencioso:true});
})();

let ultimaRecarga=0;
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='visible'){
    const agora=Date.now();
    if(agora-ultimaRecarga<3000) return;
    ultimaRecarga=agora;
    recarregarDespesas().then(ok=>{
      if(!ok) return;
      const cronoVis=!document.getElementById('tela-cronologico').classList.contains('escondido');
      const fluxoVis=!document.getElementById('tela-fluxo').classList.contains('escondido');
      const grafVis=!document.getElementById('tela-graficos').classList.contains('escondido');
      if(cronoVis) renderCronologico();
      else if(grafVis) renderGraficos();
      else if(fluxoVis) renderTelaPrincipal();
    });
  }
  if(document.visibilityState==='hidden'&&ghConfigurado()&&ghConfig.autoSync){
    if(syncTimer){clearTimeout(syncTimer);syncTimer=null}
    salvarReceitasGitHub({silencioso:true});
  }
});