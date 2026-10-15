import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, AlertCircle, ArrowUpRight, Cloud, Cpu, CreditCard, Database, ExternalLink, Info, Loader2, RefreshCw } from 'lucide-react';
import { summarizeUsage } from '../server/usage.mjs';
import './usage-view.css';

const PROVIDERS = { openai: 'OpenAI API', vertex: 'Google Vertex AI', local: 'Local Ollama', unknown: 'Unspecified provider' };
const format = value => Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString() : '—';
const readableDate = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Time unavailable';
const plural = (value, word) => `${format(value)} ${word}${value === 1 ? '' : 's'}`;
const emptyArray = value => Array.isArray(value) ? value : [];

function ProviderLink({ href, children }) {
  return <a href={href} target="_blank" rel="noopener noreferrer">{children}<ArrowUpRight size={14}/></a>;
}
function Metric({ icon: Icon, label, value, detail }) {
  return <div className="uv-metric"><span className="uv-metric-icon"><Icon size={17}/></span><span>{label}</span><strong>{format(value)}</strong><small>{detail}</small></div>;
}
function UsageDetails({ summary, scope }) {
  const tokens = summary.tokens || {}, calls = summary.calls || {}, runs = summary.runs || {};
  const models = emptyArray(summary.byModel);
  const recent = emptyArray(summary.recent);
  const hasRecords = runs.total > 0;
  return <>
    <div className="uv-metrics">
      <Metric icon={Cpu} label="Reported total tokens" value={tokens.totalTokenCount} detail="Provider-reported total; no estimate"/>
      <Metric icon={Activity} label="Recorded model calls" value={calls.reported} detail={calls.runsWithoutReportedCalls > 0 ? `${plural(calls.runsWithoutReportedCalls, 'run')} with no call count` : 'Saved inference-call counts'}/>
      <Metric icon={Database} label="Saved runs" value={runs.total} detail={`${plural(runs.withUsage || 0, 'run')} with usage metrics`}/>
    </div>
    <div className="uv-token-details" aria-label="Reported token details">
      <div><span>Input tokens</span><strong>{format(tokens.promptTokenCount)}</strong></div>
      <div><span>Output tokens</span><strong>{format(tokens.candidatesTokenCount)}</strong></div>
      <div><span>Cached input</span><strong>{format(tokens.cachedInputTokenCount)}</strong></div>
      <div><span>Reasoning tokens</span><strong>{format(tokens.reasoningTokenCount)}</strong></div>
    </div>
    <div className="uv-coverage"><Info size={15}/><p>{hasRecords ? <><strong>{plural(runs.withoutUsage || 0, 'run')} without returned usage.</strong> {plural(runs.zeroUsage || 0, 'run')} explicitly reported zero. </> : 'No reported usage in this history yet. '}A dash means the metric was not reported. Cached input and reasoning are details of the provider’s totals, and are not added again.</p></div>
    {hasRecords ? <>
      <section className="uv-section" aria-label="Usage by model">
        <div className="uv-section-heading"><h3>By model</h3><span>{plural(models.length, 'model')}</span></div>
        <div className="uv-table-scroll" tabIndex={0} role="region" aria-label="Model usage table"><table className="uv-table"><thead><tr><th scope="col">Model / provider</th><th scope="col">Runs</th><th scope="col">Calls</th><th scope="col">Total tokens</th><th scope="col">Usage missing</th></tr></thead><tbody>{models.map((model, index) => <tr key={`${model.provider}-${model.model}-${index}`}><th scope="row"><strong>{model.model || 'Unspecified model'}</strong><small>{PROVIDERS[model.provider] || PROVIDERS.unknown}</small></th><td>{format(model.runs)}</td><td>{format(model.inferenceCalls)}</td><td>{format(model.tokens?.totalTokenCount)}</td><td>{format(model.runsWithoutUsage)}</td></tr>)}</tbody></table></div>
      </section>
      <section className="uv-section" aria-label="Recent usage records"><div className="uv-section-heading"><h3>Recent records</h3><span>Latest {Math.min(20, recent.length)} · No task contents</span></div><div className="uv-record-list">{recent.map((record, index) => <div className="uv-record" key={`${record.id || 'record'}-${index}`}><span className={`uv-record-dot ${record.status === 'completed' ? 'complete' : ['failed', 'interrupted'].includes(record.status) ? 'failed' : ''}`}/><div><strong>{record.model || 'Unspecified model'}</strong><small>{PROVIDERS[record.provider] || PROVIDERS.unknown} · {readableDate(record.createdAt)}</small></div><span className="uv-record-status">{record.status || 'unknown'}</span><span className="uv-record-tokens">{record.usage?.totalTokenCount !== undefined ? `${format(record.usage.totalTokenCount)} tokens` : record.usage ? 'Partial metrics' : 'Usage unavailable'}</span></div>)}</div></section>
    </> : <div className="uv-empty"><Activity size={24}/><h3>{scope === 'browser' ? 'Quick-task history starts here.' : 'Coding history starts here.'}</h3><p>{scope === 'browser' ? 'Completed quick tasks from this browser will appear here when a provider returns usage. Clearing browser data removes this history.' : 'Saved coding runs from the companion will appear here. Failed and cancelled runs can have provider charges even when no usage was returned.'}</p></div>}
  </>;
}

export default function UsageView({ runs = [] }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const [scope, setScope] = useState('repository');
  const abort = useRef(null);
  const browser = useMemo(() => summarizeUsage(runs, { scope: 'browser' }), [runs]);
  const refresh = useCallback(async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const timeout = setTimeout(() => controller.abort(new Error('The usage check timed out. Try again.')), 20000);
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/usage', { signal: controller.signal });
      let body;
      try { body = await response.json(); } catch { throw new Error('The server returned an unreadable usage response.'); }
      if (!response.ok) throw new Error(typeof body?.message === 'string' ? body.message : typeof body?.error?.message === 'string' ? body.error.message : `Usage could not be loaded (${response.status}).`);
      if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.hasOwn(body, 'repository')) throw new Error('The server returned an incomplete usage response.');
      if (!controller.signal.aborted) setData(body);
    } catch (failure) {
      if (abort.current === controller && (!controller.signal.aborted || controller.signal.reason?.message === 'The usage check timed out. Try again.')) setError(failure.message || 'Usage could not be loaded. Try again.');
    } finally {
      clearTimeout(timeout);
      if (abort.current === controller) setBusy(false);
    }
  }, []);
  useEffect(() => { refresh(); return () => abort.current?.abort(); }, [refresh]);
  const repository = data?.repository;
  const summary = scope === 'browser' ? browser : repository;
  return <div className="usage-page">
    <div className="uv-heading"><div><span className="uv-eyebrow">YOUR WORKSPACE, ACCOUNTED FOR</span><h1>Usage <span>& billing.</span></h1><p>Recorded activity from your models. Your provider account controls the bill.</p></div><button className="uv-button" onClick={refresh} disabled={busy}><RefreshCw size={14} className={busy ? 'spin' : ''}/>{busy ? 'Checking' : 'Refresh records'}</button></div>
    <div className="uv-billing-note"><CreditCard size={18}/><div><strong>Provider-direct billing</strong><p>Easy Agent AI has no subscription checkout or shared credit balance. ChatGPT and Codex subscription allowances do not transfer to API calls. OpenAI and Vertex AI usage is billed by those providers; local models use your hardware.</p></div></div>
    {error && <div className="uv-error" role="alert"><AlertCircle size={17}/><p>{error}{data && ' Previously loaded companion records remain visible.'}</p><button onClick={refresh} disabled={busy}>Retry</button></div>}
    <div className="uv-scope-tabs" role="tablist" aria-label="Usage history location"><button id="uv-repository-tab" role="tab" aria-selected={scope === 'repository'} aria-controls="uv-history" tabIndex={scope === 'repository' ? 0 : -1} onClick={() => setScope('repository')} onKeyDown={event => { if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); setScope('browser'); document.getElementById('uv-browser-tab')?.focus(); } }}><Cloud size={16}/><span>Companion coding runs<small>Saved by the companion</small></span><strong>{repository ? format(repository.runs?.total) : '—'}</strong></button><button id="uv-browser-tab" role="tab" aria-selected={scope === 'browser'} aria-controls="uv-history" tabIndex={scope === 'browser' ? 0 : -1} onClick={() => setScope('browser')} onKeyDown={event => { if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); setScope('repository'); document.getElementById('uv-repository-tab')?.focus(); } }}><Database size={16}/><span>Quick tasks<small>Stored only in this browser</small></span><strong>{format(browser.runs.total)}</strong></button></div>
    <section className="uv-history" id="uv-history" role="tabpanel" aria-labelledby={scope === 'browser' ? 'uv-browser-tab' : 'uv-repository-tab'}>
      <div className="uv-history-heading"><div><h2>{scope === 'browser' ? 'This browser’s quick tasks' : 'Companion coding runs'}</h2><p>{scope === 'browser' ? 'At most the last 100 quick tasks stored in this browser. This history is separate from saved companion runs.' : 'At most the last 100 saved coding runs returned by the companion. This history is separate from browser quick tasks.'}</p></div>{summary?.window?.asOf && <span>Read {readableDate(summary.window.asOf)}</span>}</div>
      {summary ? <UsageDetails summary={summary} scope={scope}/> : busy ? <div className="uv-empty" role="status"><Loader2 size={24} className="spin"/><h3>Reading companion records…</h3><p>Quick-task history remains available in the other tab.</p></div> : <div className="uv-empty"><Cloud size={25}/><h3>Companion records are unavailable.</h3><p>{typeof data?.reason === 'string' ? data.reason : 'Connect the local companion to read its saved coding-run history.'}</p><button className="uv-button" onClick={refresh}>Check again<RefreshCw size={13}/></button></div>}
    </section>
    <div className="uv-limits-note"><Info size={16}/><p>These records are not an invoice or a live rate-limit meter. Provider invoices can include calls whose usage was not returned, including failed or cancelled tasks. Prices and request limits depend on the model, project and provider account.</p></div>
    <section className="uv-provider-accounts"><div className="uv-section-heading"><h2>Manage provider billing & limits</h2><ExternalLink size={15}/></div><div className="uv-account-grid"><div><span className="uv-account-icon">O</span><h3>OpenAI API</h3><p>Check actual API usage, project budgets, prices and account limits.</p><div className="uv-account-links"><ProviderLink href="https://platform.openai.com/usage">Usage dashboard</ProviderLink><ProviderLink href="https://platform.openai.com/settings/organization/billing/overview">Billing settings</ProviderLink><ProviderLink href="https://developers.openai.com/api/docs/pricing">Model pricing</ProviderLink><ProviderLink href="https://developers.openai.com/api/docs/guides/rate-limits">Rate limits guide</ProviderLink></div></div><div><span className="uv-account-icon google">G</span><h3>Google Cloud / Vertex AI</h3><p>Check the billing account and budgets attached to your Google Cloud project.</p><div className="uv-account-links"><ProviderLink href="https://console.cloud.google.com/billing">Google Cloud billing</ProviderLink></div></div></div></section>
  </div>;
}
