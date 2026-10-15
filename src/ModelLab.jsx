import React, { useMemo, useRef, useState } from 'react';
import { AlertCircle, ArrowDownToLine, ArrowRight, ArrowUpRight, Check, CheckCircle2, ChevronRight, Code2, Copy, Database, Download, FileJson2, FlaskConical, GitBranch, Layers, Loader2, ShieldCheck, Terminal, Upload, X } from 'lucide-react';
import './model-lab.css';

const MAX_BROWSER_BYTES = 400000;
const TRAINING_EXAMPLE = [
  { systemInstruction: { parts: [{ text: 'Write clear Python code and explain important edge cases.' }] }, contents: [{ role: 'user', parts: [{ text: 'Write a Python function add(a, b) that returns their sum.' }] }, { role: 'model', parts: [{ text: 'def add(a, b):\n    return a + b\n' }] }] },
  { contents: [{ role: 'user', parts: [{ text: 'Implement is_even(n) in Python for an integer n.' }] }, { role: 'model', parts: [{ text: 'def is_even(n):\n    return n % 2 == 0\n' }] }] },
].map(row => JSON.stringify(row)).join('\n');
const VALIDATION_EXAMPLE = JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Write a Python function multiply(a, b) returning their product.' }] }, { role: 'model', parts: [{ text: 'def multiply(a, b):\n    return a * b\n' }] }] });
const STEPS = [{ number: '01', title: 'Prepare', detail: 'Curate your examples', icon: Database }, { number: '02', title: 'Validate', detail: 'Check the structure', icon: CheckCircle2 }, { number: '03', title: 'Tune', detail: 'Managed Vertex jobs', icon: Layers }, { number: '04', title: 'Evaluate', detail: 'Test held-out code', icon: FlaskConical }];
const COMMANDS = [
  { title: 'Check your datasets locally', detail: 'Supports up to 16 MiB combined JSONL.', command: 'node devkit/datasets/validate.mjs training.jsonl validation.jsonl' },
  { title: 'Explore managed tuning', detail: 'Review the SDK options before submitting a paid job.', command: 'python devkit/tuning/submit.py --help' },
  { title: 'Explore isolated evaluation', detail: 'Requires local Docker, a trusted image, and gVisor.', command: 'python devkit/evaluation/evaluate.py --help' },
];
const byteSize = value => new TextEncoder().encode(value).byteLength;
const readableBytes = value => value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MiB` : value >= 1024 ? `${(value / 1024).toFixed(1)} KiB` : `${value} bytes`;

function downloadJson(filename, value) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function ModelLab() {
  const [training, setTraining] = useState('');
  const [validation, setValidation] = useState('');
  const [trainingName, setTrainingName] = useState('');
  const [validationName, setValidationName] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [sampleLoaded, setSampleLoaded] = useState(false);
  const [copied, setCopied] = useState('');
  const trainingRef = useRef(null);
  const validationRef = useRef(null);
  const totalBytes = useMemo(() => byteSize(training) + byteSize(validation), [training, validation]);
  const overLimit = totalBytes > MAX_BROWSER_BYTES;
  const errorCount = result?.issues?.filter(issue => issue.severity === 'error').length || 0;
  const warningCount = result?.issues?.filter(issue => issue.severity === 'warning').length || 0;

  function updateSplit(split, text) {
    if (split === 'training') setTraining(text); else setValidation(text);
    setResult(null); setError(''); setSampleLoaded(false);
  }
  function loadExamples() {
    setTraining(TRAINING_EXAMPLE); setValidation(VALIDATION_EXAMPLE);
    setTrainingName('example-training.jsonl'); setValidationName('example-validation.jsonl');
    setResult(null); setError(''); setSampleLoaded(true);
  }
  async function uploadSplit(split, event) {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    const other = split === 'training' ? validation : training;
    if (file.size + byteSize(other) > MAX_BROWSER_BYTES) { setError('The combined browser limit is 400,000 bytes. Use the local CLI for datasets up to 16 MiB.'); return; }
    try {
      const text = await file.text();
      if (byteSize(text) + byteSize(other) > MAX_BROWSER_BYTES) throw new Error('The combined browser limit is 400,000 bytes. Use the local CLI for larger datasets.');
      updateSplit(split, text);
      if (split === 'training') setTrainingName(file.name); else setValidationName(file.name);
    } catch (err) { setError(err.message || 'This file could not be read. Choose a UTF-8 JSONL text file.'); }
  }
  async function validateDatasets() {
    if (loading || !training.trim() || overLimit) return;
    setLoading(true); setError(''); setResult(null);
    try {
      const response = await fetch('/api/datasets/validate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ training, validation }) });
      let data;
      try { data = await response.json(); } catch { throw new Error('The validator returned an unreadable response. Try again or use the local CLI.'); }
      if (!response.ok) throw new Error(data.message || data.error || `Validation request failed (${response.status}).`);
      if (typeof data.valid !== 'boolean' || !Array.isArray(data.issues)) throw new Error('The validator returned an unexpected result. Try again or use the local CLI.');
      setResult(data);
    } catch (err) { setError(err.message || 'Could not reach the validator. Please try again.'); }
    finally { setLoading(false); }
  }
  async function copyCommand(command) {
    try { await navigator.clipboard.writeText(command); setCopied(command); setTimeout(() => setCopied(''), 2200); }
    catch { setError('Clipboard access is unavailable. Select and copy the command directly.'); }
  }

  return <div className="standard-view model-lab-view">
    <div className="ml-heading">
      <div><span className="ml-eyebrow"><FlaskConical size={13}/>THE MODEL DEVELOPMENT WORKBENCH</span><h1>Better models start<br className="ml-mobile-break"/> with better examples.</h1><p>Prepare your data, check it carefully, and take a deliberate path from a base model to measured results.</p></div>
      <a className="button secondary ml-source-link" href="/download/source.zip" download><Download size={15}/>Download development kit<ArrowUpRight size={13}/></a>
    </div>

    <div className="ml-pipeline" aria-label="Model development pipeline">
      {STEPS.map(({ number, title, detail, icon: Icon }, index) => <React.Fragment key={number}><div className={`ml-pipeline-step ${index === 1 ? 'current' : ''}`}><span className="ml-step-number">{number}</span><span className="ml-step-icon"><Icon size={18}/></span><div><strong>{title}</strong><small>{detail}</small></div></div>{index < STEPS.length - 1 && <ChevronRight className="ml-step-arrow" size={16}/>}</React.Fragment>)}
    </div>

    <div className="ml-main-grid">
      <section className="ml-dataset-card" aria-label="Dataset validator">
        <div className="ml-card-heading"><div className="ml-card-title"><span><FileJson2 size={19}/></span><div><h2>A strong foundation.</h2><p>Text-only Gemini JSONL datasets</p></div></div><button className="ml-text-button" onClick={loadExamples} disabled={loading}>Load examples<ArrowDownToLine size={13}/></button></div>
        <div className="ml-dataset-intro"><p>Use one complete example per line, with alternating <code>user</code> and <code>model</code> turns. Keep validation prompts separate from training.</p><div className="ml-format-tag"><Code2 size={13}/>contents[].parts[].text</div></div>
        {sampleLoaded && <div className="ml-sample-note"><FlaskConical size={16}/><p><strong>Illustrative examples only.</strong> These two training examples and one held-out example demonstrate the format. They are insufficient for a meaningful training run.</p></div>}
        <div className="ml-dataset-editors">
          <DatasetEditor split="training" title="Training data" badge="Required" text={training} filename={trainingName} disabled={loading} inputRef={trainingRef} onUpload={uploadSplit} onChange={value => { updateSplit('training', value); setTrainingName(''); }} onClear={() => { updateSplit('training', ''); setTrainingName(''); }}/>
          <DatasetEditor split="validation" title="Validation data" badge="Optional · recommended" text={validation} filename={validationName} disabled={loading} inputRef={validationRef} onUpload={uploadSplit} onChange={value => { updateSplit('validation', value); setValidationName(''); }} onClear={() => { updateSplit('validation', ''); setValidationName(''); }}/>
        </div>
        <div className="ml-validator-footer"><div className={`ml-byte-count ${overLimit ? 'over-limit' : ''}`}><span>{totalBytes.toLocaleString()} / 400,000 bytes</span><small>Browser limit · use the local CLI for up to 16 MiB</small></div><button className="button primary" onClick={validateDatasets} disabled={loading || !training.trim() || overLimit}>{loading ? <Loader2 size={15} className="spin"/> : <ShieldCheck size={15}/ >}{loading ? 'Validating…' : 'Validate datasets'}</button></div>
        {overLimit && <div className="ml-error" role="alert"><AlertCircle size={16}/><p>The combined dataset exceeds the 400,000-byte browser limit. Reduce the data or use the local CLI.</p></div>}
        {error && <div className="ml-error" role="alert"><AlertCircle size={16}/><p>{error}</p><button aria-label="Dismiss error" onClick={() => setError('')}><X size={14}/></button></div>}
        <div className="ml-privacy-note"><ShieldCheck size={13}/><p>Validation sends this text to the Forge server. This view does not persist datasets in browser storage or submit a training job.</p></div>
      </section>

      <aside className="ml-readiness-card"><div className="ml-readiness-top"><span className="ml-eyebrow">YOUR DEVELOPMENT ENVIRONMENT</span><span className="ml-readiness-indicator"/></div><div className="ml-readiness-art" aria-hidden="true"><div className="ml-art-orbit orbit-one"/><div className="ml-art-orbit orbit-two"/><div className="ml-art-center"><Layers size={27}/></div><span className="ml-art-node node-one"><Database size={14}/></span><span className="ml-art-node node-two"><Code2 size={14}/></span><span className="ml-art-node node-three"><FlaskConical size={14}/></span></div><h2>Built to develop.<br/>Ready to configure.</h2><p>The source kit brings dataset checks, managed tuning tools, local evaluation, and reviewable infrastructure together.</p><div className="ml-readiness-items"><div><span className="ml-state-dot"/><strong>Infrastructure</strong><span>Not provisioned</span></div><div><span className="ml-state-dot"/><strong>Google access</strong><span>Credentials required</span></div><div><span className="ml-state-dot"/><strong>Training jobs</strong><span>Not submitted here</span></div></div><div className="ml-readiness-bottom"><GitBranch size={16}/><p>Terraform and Python SDK workflows are included in the downloadable source.</p></div></aside>
    </div>

    {result && <section className={`ml-results ${result.valid ? 'passed' : 'needs-work'}`} aria-label="Dataset validation results" aria-live="polite"><div className="ml-results-heading"><span className="ml-result-icon">{result.valid ? <CheckCircle2 size={21}/> : <AlertCircle size={21}/>}</span><div><h2>{result.valid ? 'Structural checks passed' : 'A few things to put right.'}</h2><p>{result.valid ? 'The submitted data passed this text-only structural preflight.' : 'Resolve the errors below, then validate your datasets again.'} Token limits and provider acceptance are not verified.</p></div><button className="button secondary small" onClick={() => downloadJson('dazza-dataset-validation.json', result)}><Download size={13}/>Export report</button></div><div className="ml-result-metrics"><ResultMetric label="Training examples" value={result.training?.examples ?? '—'} detail={result.training ? `${result.training.duplicates} duplicates · ${readableBytes(result.training.bytes)}` : 'No valid summary'}/><ResultMetric label="Validation examples" value={result.validation?.examples ?? '—'} detail={result.validation ? `${result.validation.duplicates} duplicates · ${readableBytes(result.validation.bytes)}` : 'No validation split supplied'}/><ResultMetric label="Held-out prompt overlap" value={result.overlapCount ?? 0} detail="Keep held-out prompts separate"/><ResultMetric label="Diagnostics" value={result.issueCount ?? result.issues.length} detail={`${errorCount} errors · ${warningCount} warnings shown`}/></div><div className="ml-diagnostics-heading"><strong>Diagnostics</strong><span>{result.profile || 'Text-only structural preflight'}</span></div>{result.issues.length > 0 ? <div className="ml-diagnostics">{result.issues.map((issue, index) => <div className={`ml-diagnostic ${issue.severity === 'error' ? 'is-error' : ''}`} key={`${issue.split}-${issue.line}-${index}`}><span>{issue.severity === 'error' ? <AlertCircle size={14}/> : <CircleInfo/>}</span><div><strong>{issue.split}{issue.line > 0 ? ` · line ${issue.line}` : ' · dataset'}</strong><p>{issue.message}</p></div><span className="ml-severity">{issue.severity}</span></div>)}</div> : <div className="ml-no-diagnostics"><Check size={16}/>No diagnostics were returned.</div>}{(result.issueCount || 0) > result.issues.length && <p className="ml-truncated-note">Showing the first {result.issues.length} of {result.issueCount} diagnostics. Fix these and run validation again.</p>}<div className="ml-results-footnote"><ShieldCheck size={14}/><p>Structural validation checks formatting, supported fields, duplicates, and prompt overlap. It does not measure answer quality or confirm model availability, data rights, token limits, or benchmark contamination.</p></div></section>}

    <div className="ml-next-steps"><section className="ml-guide-card"><div className="ml-guide-icon tuning"><Layers size={20}/></div><div className="ml-guide-topline"><span>03 / TUNE</span><span className="ml-preview-badge">Public Preview</span></div><h2>Managed Gemini tuning</h2><p>Start with <code>gemini-3.5-flash</code> through the included Google Gen AI SDK workflow. Supported tuning regions: <strong>us-central1</strong> and <strong>europe-west4</strong>.</p><div className="ml-guide-detail"><CheckCircle2 size={15}/><p>Leave tuning parameters unset for your first run and review the provider’s defaults, dataset preflight, and estimated usage.</p></div><div className="ml-guide-status"><span className="ml-state-dot"/>Google credentials required<span>Submission via local CLI</span></div></section><section className="ml-guide-card"><div className="ml-guide-icon evaluation"><FlaskConical size={20}/></div><div className="ml-guide-topline"><span>04 / EVALUATE</span><span className="ml-local-badge">Local workflow</span></div><h2>Measure the code that matters.</h2><p>Evaluate candidate Python completions against held-out tests in fresh, disposable gVisor containers. Compare repeatable results before choosing a model.</p><div className="ml-guide-detail"><ShieldCheck size={15}/><p>A local Docker installation, trusted evaluation image, and configured <code>runsc</code> runtime are required. No hosted execution is provided.</p></div><div className="ml-guide-status"><span className="ml-state-dot"/>No evaluation running<span>No benchmark score claimed</span></div></section></div>

    <section className="ml-command-section"><div className="ml-command-heading"><div><span className="ml-eyebrow">FROM THE WORKBENCH TO YOUR MACHINE</span><h2>Take the next step locally.</h2><p>Download the kit, follow its setup guides, then run these commands from the repository root.</p></div><a className="ml-text-button" href="/download/source.zip" download>Get the full source<ArrowUpRight size={14}/></a></div><div className="ml-command-list">{COMMANDS.map(item => <div className="ml-command-row" key={item.command}><span className="ml-command-icon"><Terminal size={17}/></span><div className="ml-command-description"><strong>{item.title}</strong><p>{item.detail}</p></div><div className="ml-command-code"><code>{item.command}</code><button onClick={() => copyCommand(item.command)} aria-label={`Copy ${item.title.toLowerCase()} command`} title="Copy command">{copied === item.command ? <Check size={14}/> : <Copy size={14}/>}</button></div></div>)}</div></section>
    <div className="ml-bottom-note"><ShieldCheck size={15}/><p>Cloud infrastructure and paid training are configured through the development kit. No cloud resources are provisioned by this page.</p></div>
  </div>;
}

function DatasetEditor({ split, title, badge, text, filename, disabled, inputRef, onUpload, onChange, onClear }) {
  const nonemptyLines = text.split(/\r?\n/).filter(line => line.trim()).length;
  return <div className="ml-dataset-editor"><div className="ml-editor-label"><label htmlFor={`ml-${split}`}>{title}</label><span>{badge}</span></div><div className="ml-editor-controls"><span><FileJson2 size={13}/>{filename || `${split}.jsonl`}</span><button onClick={() => inputRef.current?.click()} disabled={disabled}><Upload size={12}/>Upload</button>{text && <button onClick={onClear} disabled={disabled} aria-label={`Clear ${split} data`} title="Clear dataset"><X size={12}/></button>}<input ref={inputRef} type="file" accept=".jsonl,.json,.txt,application/json,text/plain" hidden onChange={event => onUpload(split, event)} disabled={disabled}/></div><textarea id={`ml-${split}`} aria-label={`${title} JSONL`} spellCheck={false} value={text} onChange={event => onChange(event.target.value)} disabled={disabled} maxLength={MAX_BROWSER_BYTES} placeholder={split === 'training' ? '{"contents":[{"role":"user","parts":[{"text":"Your instruction"}]},{"role":"model","parts":[{"text":"Your ideal answer"}]}]}' : 'Paste held-out examples with prompts that do not appear in training…'}/><div className="ml-editor-meta"><span>{nonemptyLines} nonempty {nonemptyLines === 1 ? 'line' : 'lines'}</span><span>UTF-8 · JSONL</span></div></div>;
}
function ResultMetric({ label, value, detail }) { return <div className="ml-result-metric"><span>{label}</span><strong>{typeof value === 'number' ? value.toLocaleString() : value}</strong><small>{detail}</small></div>; }
function CircleInfo() { return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6" stroke="currentColor"/><path d="M8 7v4M8 4.5v.5" stroke="currentColor" strokeLinecap="round"/></svg>; }
