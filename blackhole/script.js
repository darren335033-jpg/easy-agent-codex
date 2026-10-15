'use strict';
const byId=id=>document.getElementById(id);
const money=value=>new Intl.NumberFormat('en-AU',{style:'currency',currency:'AUD',maximumFractionDigits:0}).format(value);
const fields=['leads','conversion','improvement','order','cost'];
function updateCalculator(){
 const v=Object.fromEntries(fields.map(x=>[x,Number(byId(x).value)]));
 byId('leadsValue').textContent=v.leads.toLocaleString('en-AU');
 byId('conversionValue').textContent=v.conversion+'%';
 byId('improvementValue').textContent=v.improvement+'%';
 byId('orderValue').textContent=money(v.order);
 byId('costValue').textContent=money(v.cost);
 const extra=v.leads*(v.conversion/100)*(v.improvement/100),gross=extra*v.order;
 byId('salesResult').textContent=money(gross);
 byId('salesCount').textContent=extra.toFixed(1);
 byId('netResult').textContent=money(gross-v.cost);
 byId('multipleResult').textContent=v.cost>0?(gross/v.cost).toFixed(1)+'×':'N/A';
}
fields.forEach(id=>byId(id).addEventListener('input',updateCalculator));updateCalculator();
byId('year').textContent=new Date().getFullYear();
byId('menuButton').addEventListener('click',()=>{const nav=document.querySelector('.header nav'),open=nav.classList.toggle('open');byId('menuButton').setAttribute('aria-expanded',String(open));});
document.querySelectorAll('.header nav a').forEach(a=>a.addEventListener('click',()=>{document.querySelector('.header nav').classList.remove('open');byId('menuButton').setAttribute('aria-expanded','false');}));
// Contact transport is deliberately client-side mailto; no hidden collection endpoint.
// Replace with a consent-aware authenticated API before calling lead capture 'live'.
byId('enquiryForm').addEventListener('submit',event=>{
 event.preventDefault();const form=event.currentTarget;
 if(!form.reportValidity())return;
 const data=new FormData(form),subject='BlackHole Money business enquiry',body=[
 'Name: '+data.get('name'),'Email: '+data.get('email'),'Business: '+data.get('business'),
 'Interest: '+data.get('interest'),'Project: '+data.get('message'),'',
 'I consent to Easy Agent Agency contacting me about this enquiry.'
 ].join('\n');
 // Contact email is a deployment setting: configure window.BLACKHOLE_CONTACT_EMAIL to activate.
 const address=window.BLACKHOLE_CONTACT_EMAIL;
 if(!address || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)){
  byId('formStatus').textContent='Contact inbox has not been configured. Please ask the site owner to set BLACKHOLE_CONTACT_EMAIL in config.js.';return;
 }
 window.location.href='mailto:'+encodeURIComponent(address)+'?subject='+encodeURIComponent(subject)+'&body='+encodeURIComponent(body);
 byId('formStatus').textContent='Your email application should open. Review the prepared enquiry and press Send there.';
});
