"use client";

import { useEffect, useMemo, useState } from "react";
import OpeningBalanceControl from "./opening-balance-control";

type Row = Record<string, string | number | boolean | null>;
type StatementAccount = Row & { category: string; statementLine: string; liquidity: string };
type Comparison = { label:string;from:string;to:string;source:"ERP_POSTED"|"HISTORICAL_CLOSE";revenue:number;expenses:number;netIncome:number;monthCount?:number };
type LedgerData = { asOf:string; from:string; to:string; accounts:Row[]; rows:Row[];
  pagination:{returned:number;total:number;limit:number}; totals:Record<string,number>;
  statements:{status:"OFFICIAL"|"DRAFT";
    incomeStatement:{revenue:number;expenses:number;netIncome:number;
      salesRevenue:number;cogs:number;grossProfit:number;sga:number;operatingIncome:number;
      nonOperatingIncome:number;nonOperatingExpense:number;preTaxIncome:number;incomeTax:number;rows:StatementAccount[]};
    balanceSheet:{assets:number;liabilities:number;equity:number;currentEarnings:number;equationDifference:number;
      currentAssets:number;nonCurrentAssets:number;currentLiabilities:number;nonCurrentLiabilities:number;rows:StatementAccount[]};
    quality:{openingOfficial:boolean;unclassifiedCount:number;unclassifiedAccounts:Array<{code:string;name:string}>;equationBalanced:boolean;
      unclassifiedStatementLineAccounts:Array<{code:string;name:string}>;unclassifiedLiquidityAccounts:Array<{code:string;name:string}>}};
  comparisons:{current:Comparison;previousPeriod:Comparison|null;priorYear:Comparison|null;priorYearRule:string;
    closingReference:{label:string;asOf:string;assets:number;cash:number;accountsReceivable:number;accountsPayable:number;debt:number;scopeNote:string}};
  sources:{opening:{label:string;asOf:string;immutableReference:boolean;official:boolean;setId:string};controlledPostingLines:number;postedOnly:boolean;stagedOrClobeRowsIncluded:boolean;importOnly:boolean};
  controls:{balanced:boolean;openingApprovedReference:boolean;statementOfficial:boolean;sourceMutation:boolean;directClobePosting:boolean} };
const won=(value:unknown)=>`${Number(value??0).toLocaleString("ko-KR")}원`;
const dateTime=(value:unknown)=>value?new Date(Number(value)).toLocaleString("ko-KR",{dateStyle:"short",timeStyle:"short"}):"—";
const statementAccountAmount=(row:StatementAccount)=>["ASSET","EXPENSE"].includes(row.category)
  ? Number(row.category==="EXPENSE"?row.periodDebit:row.endingDebit)-Number(row.category==="EXPENSE"?row.periodCredit:row.endingCredit)
  : Number(row.category==="REVENUE"?row.periodCredit:row.endingCredit)-Number(row.category==="REVENUE"?row.periodDebit:row.endingDebit);
const deltaLabel=(current:number,prior:number)=>prior===0?"비교율 없음":`${((current-prior)/Math.abs(prior)*100)>=0?"+":""}${((current-prior)/Math.abs(prior)*100).toFixed(1)}%`;

export default function GeneralLedgerWorkspace(){
  const [data,setData]=useState<LedgerData|null>(null);const [from,setFrom]=useState("2026-01-01");const [to,setTo]=useState("");
  const [account,setAccount]=useState("");const [query,setQuery]=useState("");const [busy,setBusy]=useState(false);const [error,setError]=useState("");
  async function load(nextFrom=from,nextTo=to,nextAccount=account,nextQuery=query){setBusy(true);setError("");try{const params=new URLSearchParams({from:nextFrom});if(nextTo)params.set("to",nextTo);if(nextAccount)params.set("account",nextAccount);if(nextQuery.trim())params.set("q",nextQuery.trim());const response=await fetch(`/api/finance/general-ledger?${params}`,{cache:"no-store"});const payload=await response.json() as LedgerData&{error?:string};if(!response.ok)throw new Error(payload.error||"총계정원장을 불러오지 못했습니다.");setData(payload);setTo(payload.to);}catch(caught){setError(caught instanceof Error?caught.message:"총계정원장을 불러오지 못했습니다.");}finally{setBusy(false);}}
  useEffect(()=>{let cancelled=false;fetch("/api/finance/general-ledger",{cache:"no-store"}).then(async(response)=>{const payload=await response.json() as LedgerData&{error?:string};if(!response.ok)throw new Error(payload.error||"총계정원장을 불러오지 못했습니다.");if(!cancelled){setData(payload);setFrom(payload.from);setTo(payload.to);}}).catch((caught)=>{if(!cancelled)setError(caught instanceof Error?caught.message:"총계정원장을 불러오지 못했습니다.");});return()=>{cancelled=true;};},[]);
  const selected=useMemo(()=>data?.accounts.find((row)=>String(row.key)===account),[account,data]);
  const statementReasons = !data ? [] : [
    ...(!data.statements.quality.openingOfficial ? ["개시잔액 승인 필요"] : []),
    ...(data.statements.quality.unclassifiedCount ? [`미분류 계정 ${data.statements.quality.unclassifiedCount}개`] : []),
    ...(!data.statements.quality.equationBalanced ? [`회계등식 차이 ${won(data.statements.balanceSheet.equationDifference)}`] : []),
    ...(!data.controls.balanced ? ["총계정원장 차대변 불일치"] : []),
    ...(data.statements.quality.unclassifiedStatementLineAccounts.length ? [`손익 라인 미분류 계정 ${data.statements.quality.unclassifiedStatementLineAccounts.length}개 · 매출총이익·영업이익 소계 제외`] : []),
    ...(data.statements.quality.unclassifiedLiquidityAccounts.length ? [`유동·비유동 미분류 계정 ${data.statements.quality.unclassifiedLiquidityAccounts.length}개`] : []),
  ];
  // 3799류 "당기순이익" 계정은 전기(2025) 결산 원본을 그대로 이월한 값이며, 결산분개(집합손익 →
  // 이익잉여금 대체)가 XD NODE 밖(이카운트)에서 이루어지므로 여기서는 상계하지 않는다. 2026년에
  // 한 번도 전기되지 않았다면(당기 차대변 0) "이번 조회기간 손익"이 아니라 이월분임을 밝혀 둔다.
  const staleEquityNote = (row: StatementAccount) => row.category === "EQUITY"
    && /당기순이익/.test(String(row.accountName)) && !Number(row.periodDebit) && !Number(row.periodCredit)
    ? " (전기 이월, 2026년 미변동)" : "";
  function download(){const params=new URLSearchParams({from,to,format:"csv"});if(account)params.set("account",account);if(query.trim())params.set("q",query.trim());window.location.href=`/api/finance/general-ledger?${params}`;}
  return <><div className="finance-subpage-heading general-ledger-heading"><div data-korean-heading><h2>총계정원장·2026 시산표</h2><span>승인된 개시 기준선에 실제 전기된 2026 분개만 이어서 조회합니다.</span></div><div><button type="button" onClick={download}>CSV 내려받기</button></div></div>
    {error&&<div className="data-governance-message error">{error}</div>}
    <OpeningBalanceControl />
    <section className="general-ledger-controls panel"><label>시작일<input type="date" min="2026-01-01" max={data?.asOf} value={from} onChange={(event)=>setFrom(event.target.value)}/></label><label>종료일<input type="date" min="2026-01-01" max={data?.asOf} value={to} onChange={(event)=>setTo(event.target.value)}/></label><label>계정<select value={account} onChange={(event)=>{setAccount(event.target.value);void load(from,to,event.target.value,query);}}><option value="">전체 계정</option>{data?.accounts.map((row)=><option value={String(row.key)} key={String(row.key)}>{String(row.accountCode||"—")} · {String(row.accountName)}</option>)}</select></label><label>전표·적요 검색<input value={query} placeholder="전표번호, 거래처, 적요" onChange={(event)=>setQuery(event.target.value)}/></label><button type="button" disabled={busy} onClick={()=>void load()}>{busy?"조회 중…":"조회"}</button></section>
    <section className="general-ledger-quality"><article className={data?.totals.openingDifference===0?"pass":"fail"}><span>개시 차대변</span><strong>{data?.totals.openingDifference===0?"일치":"불일치"}</strong><small>{data?.sources.opening.label} · {data?.sources.opening.asOf}</small></article><article className={data?.totals.periodDifference===0?"pass":"fail"}><span>당기 차대변</span><strong>{won(data?.totals.periodDebit)}</strong><small>차이 {won(data?.totals.periodDifference)} · 전기 완료만</small></article><article className={data?.totals.endingDifference===0?"pass":"fail"}><span>기말 차대변</span><strong>{data?.controls.balanced?"일치":"불일치"}</strong><small>차 {won(data?.totals.endingDebit)} · 대 {won(data?.totals.endingCredit)}</small></article><article><span>전기 원천</span><strong>{Number(data?.sources.controlledPostingLines??0)}행</strong><small>이카운트 분개장 import분만 · ERP 지급 실행 기록은 제외</small></article></section>
    <section className={`panel operational-statements ${data?.statements.status.toLowerCase()??"draft"}`}>
      <header><div data-korean-heading><h3>2026 손익계산서·재무상태표</h3><span>승인된 개시잔액과 전기 완료된 ERP 분개만 사용합니다.</span></div><em>{data?.statements.status==="OFFICIAL"?"공식 기준":"검토용 초안"}</em></header>
      {statementReasons.length>0&&<div className="statement-quality-warning"><strong>공식화 전 확인</strong><span>{statementReasons.join(" · ")}</span></div>}
      <div className="statement-grid">
        <article><header><div data-korean-heading><h4>손익계산서</h4></div><span>{data?.from}–{data?.to}</span></header><dl>
            <div><dt>매출액</dt><dd>{won(data?.statements.incomeStatement.salesRevenue)}</dd></div>
            <div><dt>매출원가</dt><dd>{won(data?.statements.incomeStatement.cogs)}</dd></div>
            <div className="statement-total"><dt>매출총이익</dt><dd>{won(data?.statements.incomeStatement.grossProfit)}</dd></div>
            <div><dt>판매비와관리비</dt><dd>{won(data?.statements.incomeStatement.sga)}</dd></div>
            <div className="statement-total"><dt>영업이익</dt><dd>{won(data?.statements.incomeStatement.operatingIncome)}</dd></div>
            <div><dt>영업외수익</dt><dd>{won(data?.statements.incomeStatement.nonOperatingIncome)}</dd></div>
            <div><dt>영업외비용</dt><dd>{won(data?.statements.incomeStatement.nonOperatingExpense)}</dd></div>
            <div className="statement-total"><dt>법인세차감전순이익</dt><dd>{won(data?.statements.incomeStatement.preTaxIncome)}</dd></div>
            <div><dt>법인세비용</dt><dd>{won(data?.statements.incomeStatement.incomeTax)}</dd></div>
            <div className="statement-total"><dt>당기순이익</dt><dd>{won(data?.statements.incomeStatement.netIncome)}</dd></div>
          </dl><div className="statement-account-list">{data?.statements.incomeStatement.rows.filter((row)=>statementAccountAmount(row)!==0).map((row)=><div key={`is-${String(row.key)}`}><span>{String(row.accountCode||"—")} · {String(row.accountName)}</span><strong>{won(statementAccountAmount(row))}</strong></div>)}{!data?.statements.incomeStatement.rows.some((row)=>statementAccountAmount(row)!==0)&&<p>조회기간에 전기된 수익·비용이 없습니다.</p>}</div></article>
        <article><header><div data-korean-heading><h4>재무상태표</h4></div><span>{data?.to} 기준</span></header><dl>
            <div><dt>유동자산</dt><dd>{won(data?.statements.balanceSheet.currentAssets)}</dd></div>
            <div><dt>비유동자산</dt><dd>{won(data?.statements.balanceSheet.nonCurrentAssets)}</dd></div>
            <div className="statement-total"><dt>자산총계</dt><dd>{won(data?.statements.balanceSheet.assets)}</dd></div>
            <div><dt>유동부채</dt><dd>{won(data?.statements.balanceSheet.currentLiabilities)}</dd></div>
            <div><dt>비유동부채</dt><dd>{won(data?.statements.balanceSheet.nonCurrentLiabilities)}</dd></div>
            <div className="statement-total"><dt>부채총계</dt><dd>{won(data?.statements.balanceSheet.liabilities)}</dd></div>
            <div><dt>자본</dt><dd>{won(data?.statements.balanceSheet.equity)}</dd></div>
            <div><dt>당기손익(YTD·미마감)</dt><dd>{won(data?.statements.balanceSheet.currentEarnings)}</dd></div>
            <div className="statement-total"><dt>회계등식 차이</dt><dd>{won(data?.statements.balanceSheet.equationDifference)}</dd></div>
          </dl><div className="statement-account-list">{data?.statements.balanceSheet.rows.filter((row)=>statementAccountAmount(row)!==0).map((row)=><div key={`bs-${String(row.key)}`}><span>{String(row.accountCode||"—")} · {String(row.accountName)}{staleEquityNote(row)}</span><strong>{won(statementAccountAmount(row))}</strong></div>)}</div></article>
      </div>
    </section>
    <section className="panel statement-comparison">
      <header><div data-korean-heading><h3>손익 비교</h3><span>전기 완료 원장과 확정 결산자료를 서로 다른 기준으로 명확히 구분합니다.</span></div><em>부분월 일할 계산 없음</em></header>
      <div className="statement-comparison-table">
        <div className="head"><span>지표</span><span>현재 조회기간<small>{data?.comparisons.current.from}–{data?.comparisons.current.to}</small></span><span>직전 동일 일수<small>{data?.comparisons.previousPeriod?`${data.comparisons.previousPeriod.from}–${data.comparisons.previousPeriod.to}`:"2026년 이전으로 넘어가 비교 불가"}</small></span><span>2025 동일 완료월<small>{data?.comparisons.priorYear?`${data.comparisons.priorYear.from}–${data.comparisons.priorYear.to} · ${data.comparisons.priorYear.monthCount}개월`:"완전히 포함된 월 없음"}</small></span></div>
        {([['revenue','매출·수익'],['expenses','비용'],['netIncome','당기순이익']] as const).map(([key,label])=><div key={key}><strong>{label}{key==='expenses'&&<small>2025 비교값은 매출-순이익 역산</small>}</strong><span>{won(data?.comparisons.current[key])}</span><span>{data?.comparisons.previousPeriod?<>{won(data.comparisons.previousPeriod[key])}<small>{deltaLabel(data.comparisons.current[key],data.comparisons.previousPeriod[key])}</small></>:"—"}</span><span>{data?.comparisons.priorYear?<>{won(data.comparisons.priorYear[key])}<small>{deltaLabel(data.comparisons.current[key],data.comparisons.priorYear[key])}</small></>:"—"}</span></div>)}
      </div>
      <div className="statement-closing-reference"><header><strong>{data?.comparisons.closingReference.label}</strong><span>{data?.comparisons.closingReference.asOf} · 손익 비교와 별도 기준</span></header><div><p><small>총자산</small><strong>{won(data?.comparisons.closingReference.assets)}</strong></p><p><small>현금성 자산</small><strong>{won(data?.comparisons.closingReference.cash)}</strong></p><p><small>매출채권</small><strong>{won(data?.comparisons.closingReference.accountsReceivable)}</strong></p><p><small>매입채무</small><strong>{won(data?.comparisons.closingReference.accountsPayable)}</strong></p><p><small>차입금</small><strong>{won(data?.comparisons.closingReference.debt)}</strong></p></div><small>{data?.comparisons.closingReference.scopeNote}</small></div>
      <footer>{data?.comparisons.priorYearRule}</footer>
    </section>
    <section className="panel general-trial-balance"><header><div data-korean-heading><h3>{selected?`${String(selected.accountName)} 계정 요약`:"2026 합계잔액시산표"}</h3><span>개시잔액 + 조회기간 전기 합계 + 계산된 기말잔액</span></div><em>{data?.accounts.length??0}개 계정</em></header><div className="general-ledger-table trial"><div className="head"><span>계정</span><span>개시 차변</span><span>개시 대변</span><span>당기 차변</span><span>당기 대변</span><span>기말 차변</span><span>기말 대변</span><span>행</span></div>{data?.accounts.filter((row)=>!account||String(row.key)===account).map((row)=><div key={String(row.key)}><p><strong>{String(row.accountCode||"—")}</strong><small>{String(row.accountName)}</small></p><span>{Number(row.openingDebit)?won(row.openingDebit):"—"}</span><span>{Number(row.openingCredit)?won(row.openingCredit):"—"}</span><span>{Number(row.periodDebit)?won(row.periodDebit):"—"}</span><span>{Number(row.periodCredit)?won(row.periodCredit):"—"}</span><b>{Number(row.endingDebit)?won(row.endingDebit):"—"}</b><b>{Number(row.endingCredit)?won(row.endingCredit):"—"}</b><em>{Number(row.lineCount)}행</em></div>)}</div></section>
    <section className="panel general-ledger-lines"><header><div data-korean-heading><h3>전기 분개 상세</h3><span>검증 스테이징과 Clobe 원문은 포함하지 않습니다.</span></div><em>{data?.pagination.total??0}행 중 {data?.pagination.returned??0}행</em></header><div className="general-ledger-table lines"><div className="head"><span>일자·전표</span><span>계정·적요</span><span>거래처·부서</span><span>차변</span><span>대변</span><span>원천·전기시각</span></div>{data?.rows.map((row)=><div key={String(row.id)}><p><strong>{String(row.voucherDate)}</strong><small>{String(row.voucherNumber)} · {Number(row.lineNumber)}행</small></p><p><strong>{String(row.accountCode||"—")} · {String(row.accountName)}</strong><small>{String(row.description||"적요 없음")}</small></p><p><strong>{String(row.partnerName||"—")}</strong><small>{String(row.departmentName||"부서 없음")}</small></p><b>{Number(row.debitAmount)?won(row.debitAmount):"—"}</b><b>{Number(row.creditAmount)?won(row.creditAmount):"—"}</b><p><strong>통제 분개</strong><small>{dateTime(row.postedAt)}</small></p></div>)}{!data?.rows.length&&<div className="finance-empty">선택한 조건에 전기된 분개가 없습니다.</div>}</div></section>
    <div className="chart-coverage-note general-ledger-note"><span>i</span>이 화면은 이카운트 분개장 import분만을 원장으로 삼는 검증 화면입니다. ERP가 생성한 지급 실행 기록(지급전표·감가상각 전표)과 2026 Clobe 원문·파일 검증 결과는 승인·전기되기 전까지 합산하지 않습니다.</div></>;
}
