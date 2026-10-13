import {mkdirSync,lstatSync,chmodSync} from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const secured=new Set();
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
function checkComponents(directory){
 const absolute=path.resolve(directory),root=path.parse(absolute).root;
 let current=root;
 for(const part of absolute.slice(root.length).split(path.sep).filter(Boolean)){
  current=path.join(current,part);
  try{const info=lstatSync(current);if(info.isSymbolicLink()||!info.isDirectory())throw fail('Storage directory must not traverse symlinks or non-directories.');}
  catch(error){if(error.code==='ENOENT')return;throw error;}
 }
}
const windowsAclScript=`$ErrorActionPreference='Stop'
$directory=$env:EASY_AGENT_PRIVATE_STORAGE_DIR
$owner=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system=New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
$acl=New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetOwner($owner)
$acl.SetAccessRuleProtection($true,$false)
$inherit=[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
$propagation=[System.Security.AccessControl.PropagationFlags]::None
$allow=[System.Security.AccessControl.AccessControlType]::Allow
$rights=[System.Security.AccessControl.FileSystemRights]::FullControl
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($owner,$rights,$inherit,$propagation,$allow)))
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($system,$rights,$inherit,$propagation,$allow)))
Set-Acl -LiteralPath $directory -AclObject $acl
$verified=Get-Acl -LiteralPath $directory
if(-not $verified.AreAccessRulesProtected){throw 'Storage ACL is not protected.'}
foreach($rule in $verified.Access){if($rule.AccessControlType -eq $allow){$sid=$rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value;if($sid -ne $owner.Value -and $sid -ne $system.Value){throw 'Unexpected storage ACL grant.'}}}
`;
export function protectDirectorySync(directory){
 const absolute=path.resolve(directory);
 checkComponents(absolute);mkdirSync(absolute,{recursive:true,mode:0o700});checkComponents(absolute);
 if(process.platform!=='win32'){chmodSync(absolute,0o700);return;}
 if(secured.has(absolute.toLowerCase()))return;
 const executable=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
 const result=spawnSync(executable,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(windowsAclScript,'utf16le').toString('base64')],{env:{...process.env,EASY_AGENT_PRIVATE_STORAGE_DIR:absolute},stdio:['ignore','pipe','pipe'],windowsHide:true,timeout:15000,maxBuffer:65536});
 if(result.error||result.status!==0)throw fail('Unable to enforce private Windows storage permissions.',500);
 secured.add(absolute.toLowerCase());
}
export async function protectDirectory(directory){protectDirectorySync(directory);}
