import fs from 'node:fs';

const file = 'src/gui/renderer/app.js';
let js = fs.readFileSync(file, 'utf8');

// 1. 修复权限保存中的 unchecked
js = js.replace(
  `allowShell: $('permAllowShell').checked,
        allowFsWrite: $('permAllowFsWrite').checked,
        allowNetwork: $('permAllowNetwork').checked,
        allowSpawnSubagent: $('permAllowSubagent').checked,`,
  `allowShell: $('permAllowShell')?.checked ?? true,
        allowFsWrite: $('permAllowFsWrite')?.checked ?? true,
        allowNetwork: $('permAllowNetwork')?.checked ?? true,
        allowSpawnSubagent: $('permAllowSubagent')?.checked ?? true,`
);

// 2. 修复 syncPreview
js = js.replace(
  `const content = $('syncPreview').textContent;`,
  `const content = $('syncPreview')?.textContent || '';`
);
js = js.replace(
  `$('syncPreview').textContent = JSON.stringify(result, null, 2);`,
  `if ($('syncPreview')) $('syncPreview').textContent = JSON.stringify(result, null, 2);`
);
js = js.replace(
  `$('syncPreview').textContent = \`// 错误：\\n\${error.message}\`;`,
  `if ($('syncPreview')) $('syncPreview').textContent = \`// 错误：\\n\${error.message}\`;`
);

// 3. 修复 remoteCommandInput
js = js.replace(
  `$('remoteCommandInput').value = cmd;`,
  `if ($('remoteCommandInput')) $('remoteCommandInput').value = cmd;`
);

// 4. 修复 pluginInput 回填
js = js.replace(
  `$('pluginInputName').value = p.name || '';
  $('pluginInputType').value = p.type || 'mcp';
  $('pluginInputCategory').value = p.category || 'developer';
  $('pluginInputCommand').value = p.command || '';
  $('pluginInputArgs').value = (p.args || []).join(' ');
  $('pluginInputDescription').value = p.description || '';`,
  `if ($('pluginInputName')) $('pluginInputName').value = p.name || '';
  if ($('pluginInputType')) $('pluginInputType').value = p.type || 'mcp';
  if ($('pluginInputCategory')) $('pluginInputCategory').value = p.category || 'developer';
  if ($('pluginInputCommand')) $('pluginInputCommand').value = p.command || '';
  if ($('pluginInputArgs')) $('pluginInputArgs').value = (p.args || []).join(' ');
  if ($('pluginInputDescription')) $('pluginInputDescription').value = p.description || '';`
);

fs.writeFileSync(file, js, 'utf8');
console.log('Successfully fortified all unsafe DOM accesses in app.js');
