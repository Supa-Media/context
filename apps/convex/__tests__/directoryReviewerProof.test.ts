import {afterEach, expect, test, vi} from 'vitest';
import {internal} from '../_generated/api';
import {setupTest,createUser,asPhoneOnly,captureError,errorCode} from './fixtures.helpers';
import {DIRECTORY_REVIEW_EMAIL,DIRECTORY_REVIEW_PROVIDER_ID} from '../functions/lib/reviewerAccount';
afterEach(()=>vi.unstubAllEnvs());
test('only the configured, verified, fixed-provider sample principal can approve a connector without inbox access',async()=>{
 vi.stubEnv('DIRECTORY_REVIEW_SIGNIN_CODE','731905');
 const t=setupTest();const uid=await createUser(t,DIRECTORY_REVIEW_EMAIL);const session=await asPhoneOnly(t,uid);
 await t.run(ctx=>ctx.db.insert('authAccounts',{userId:uid,provider:DIRECTORY_REVIEW_PROVIDER_ID,providerAccountId:DIRECTORY_REVIEW_EMAIL}));
 expect(await session.view.query(internal.functions.emailProof.requireConnectorProof,{})).toBeNull();
 expect(errorCode(await captureError(()=>session.view.query(internal.functions.emailProof.requireProof,{})))).toBe('EMAIL_PROOF_REQUIRED');
 vi.stubEnv('DIRECTORY_REVIEW_SIGNIN_CODE','');
 expect(errorCode(await captureError(()=>session.view.query(internal.functions.emailProof.requireConnectorProof,{})))).toBe('EMAIL_PROOF_REQUIRED');
});
for(const email of ['connector-review@supa.media','real@example.com',DIRECTORY_REVIEW_EMAIL])test(`no connector-proof exception from the address alone: ${email}`,async()=>{
 vi.stubEnv('DIRECTORY_REVIEW_SIGNIN_CODE','731905');const t=setupTest();const uid=await createUser(t,email);const session=await asPhoneOnly(t,uid);
 expect(errorCode(await captureError(()=>session.view.query(internal.functions.emailProof.requireConnectorProof,{})))).toBe('EMAIL_PROOF_REQUIRED');
});
for(const invalid of ['unverified','revoked','other owner'])test(`sample exception refuses ${invalid}`,async()=>{
 vi.stubEnv('DIRECTORY_REVIEW_SIGNIN_CODE','731905');const t=setupTest();const uid=await createUser(t,DIRECTORY_REVIEW_EMAIL);const session=await asPhoneOnly(t,uid);
 const other=await createUser(t,'other@example.com');
 await t.run(async ctx=>{await ctx.db.insert('authAccounts',{userId:invalid==='other owner'?other:uid,provider:DIRECTORY_REVIEW_PROVIDER_ID,providerAccountId:DIRECTORY_REVIEW_EMAIL});if(invalid==='unverified')await ctx.db.patch(uid,{emailVerificationTime:undefined});if(invalid==='revoked')await ctx.db.delete(session.sessionId);});
 expect(errorCode(await captureError(()=>session.view.query(internal.functions.emailProof.requireConnectorProof,{})))).toBe(invalid==='revoked'?'NOT_AUTHENTICATED':'EMAIL_PROOF_REQUIRED');
});
