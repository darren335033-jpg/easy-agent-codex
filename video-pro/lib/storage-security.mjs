import {mkdirSync,lstatSync,chmodSync} from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
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
$target=$env:EASY_AGENT_PRIVATE_STORAGE_TARGET
$owner=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system=[System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$isDirectory=$env:EASY_AGENT_PRIVATE_STORAGE_KIND -eq 'directory'
if($isDirectory){$acl=[System.Security.AccessControl.DirectorySecurity]::new();$inherit=[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{$acl=[System.Security.AccessControl.FileSecurity]::new();$inherit=[System.Security.AccessControl.InheritanceFlags]::None}
$acl.SetOwner($owner)
$acl.SetAccessRuleProtection($true,$false)
$propagation=[System.Security.AccessControl.PropagationFlags]::None
$allow=[System.Security.AccessControl.AccessControlType]::Allow
$rights=[System.Security.AccessControl.FileSystemRights]::FullControl
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($owner,$rights,$inherit,$propagation,$allow))
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($system,$rights,$inherit,$propagation,$allow))
Set-Acl -LiteralPath $target -AclObject $acl
$verified=Get-Acl -LiteralPath $target
if(-not $verified.AreAccessRulesProtected){throw 'Storage ACL is not protected.'}
if($verified.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $owner.Value){throw 'Storage owner mismatch.'}
$granted=@{}
foreach($rule in $verified.Access){$sid=$rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value;if($rule.AccessControlType -ne $allow -or ($sid -ne $owner.Value -and $sid -ne $system.Value)){throw 'Unexpected storage ACL rule.'};if(($rule.FileSystemRights -band $rights) -ne $rights){throw 'Storage ACL grants incomplete rights.'};$granted[$sid]=$true}
if(-not $granted.ContainsKey($owner.Value) -or -not $granted.ContainsKey($system.Value)){throw 'Required storage ACL grant missing.'}
`;
function windowsProtect(absolute,kind){
 const executable=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
 const result=spawnSync(executable,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(windowsAclScript,'utf16le').toString('base64')],{env:{...process.env,EASY_AGENT_PRIVATE_STORAGE_TARGET:absolute,EASY_AGENT_PRIVATE_STORAGE_KIND:kind},stdio:['ignore','pipe','pipe'],windowsHide:true,timeout:15000,maxBuffer:65536});
 if(result.error||result.status!==0){const error=fail('Unable to enforce private Windows storage permissions.',500);if(process.env.NODE_ENV==='test')error.cause=new Error((result.stderr?.toString()||result.error?.message||`PowerShell exit ${result.status}`).slice(0,4096));throw error;}
}
export function protectDirectorySync(directory){
 const absolute=path.resolve(directory);
 checkComponents(absolute);mkdirSync(absolute,{recursive:true,mode:0o700});checkComponents(absolute);
 if(process.platform!=='win32'){chmodSync(absolute,0o700);return;}
 windowsProtect(absolute,'directory');
}
export function protectFileSync(file){
 const absolute=path.resolve(file);checkComponents(path.dirname(absolute));
 const info=lstatSync(absolute);if(info.isSymbolicLink()||!info.isFile())throw fail('Private storage target must be a regular file.');
 if(process.platform!=='win32'){chmodSync(absolute,0o600);return;}
 windowsProtect(absolute,'file');
}
export async function protectDirectory(directory){protectDirectorySync(directory);}
export async function protectFile(file){protectFileSync(file);}
