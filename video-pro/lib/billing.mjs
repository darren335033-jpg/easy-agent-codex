import {randomBytes} from 'node:crypto';
const fail=(status,message)=>Object.assign(new Error(message),{status});
export async function createBilling(env,plans,{client}={}){
 const configured=Boolean(env.STRIPE_RESTRICTED_KEY&&env.STRIPE_WEBHOOK_SECRET);
 const enabled=configured&&plans.billingEnabled===true&&plans.unitEconomicsVerified===true;
 if(configured&&!client){const {default:StripeClient}=await import('stripe');client=new StripeClient(env.STRIPE_RESTRICTED_KEY,{apiVersion:'2026-08-26.dahlia',maxNetworkRetries:0,timeout:15000});}
 return {enabled,async checkout(planId,origin,userId){
  const plan=plans.plans.find(p=>p.id===planId);if(!plan)throw fail(400,'Unknown pricing tier.');
  if(!enabled)throw fail(503,'Checkout disabled: verify Stripe, webhook delivery and plan unit economics before sale.');
  if(typeof userId!=='string'||!userId)throw fail(401,'Verified account required for checkout.');
  const price=env[`STRIPE_PRICE_${planId.toUpperCase()}`];if(!price?.startsWith('price_'))throw fail(503,'This tier has no configured Stripe price.');
  try{const session=await client.checkout.sessions.create({mode:'subscription',client_reference_id:userId,metadata:{user_id:userId,plan_id:planId},subscription_data:{metadata:{user_id:userId,plan_id:planId}},line_items:[{price,quantity:1}],success_url:`${origin}/#pricing`,cancel_url:`${origin}/#pricing`,integration_identifier:`easy_agent_${randomBytes(8).toString('hex').replace(/[0-9]/g,'a')}`});const url=new URL(session.url);if(url.protocol!=='https:'||url.hostname!=='checkout.stripe.com')throw Error();return {url:url.href}}catch{throw fail(502,'Stripe checkout unavailable.');}
 },verifyWebhook(body,signature){
  if(!configured)throw fail(503,'Billing webhook handling is not configured.');
  try{return client.webhooks.constructEvent(body,signature,env.STRIPE_WEBHOOK_SECRET)}catch{throw fail(400,'Invalid Stripe webhook signature.');}
 }};
}
