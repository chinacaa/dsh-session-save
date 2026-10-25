# Native "Save As" dialog for dsh-session-save.
# Prints exactly one line: RESULT:<full path>  (empty after the colon = cancelled).
# When -ResultFile is given the same line is also written there as UTF-8 (no BOM),
# so the caller never has to depend on the console code page.
param(
    [Parameter(Mandatory = $false)][string]$Initial = '',
    [Parameter(Mandatory = $false)][string]$Filter = 'DSH 会话工程 (*.dsproj)|*.dsproj|所有文件 (*.*)|*.*',
    [Parameter(Mandatory = $false)][string]$ResultFile = ''
)

$ErrorActionPreference = 'Stop'

# Windows PowerShell 5.1 writes stdout in the console code page (GBK on a Chinese
# Windows), which a UTF-8 reader turns into mojibake. Force UTF-8 up front.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# A hidden owner form keeps the dialog above the browser window instead of
# opening behind it, and gives the taskbar entry a stable parent.
$owner = New-Object System.Windows.Forms.Form
$owner.Text = 'DSH'
$owner.ShowInTaskbar = $false
$owner.FormBorderStyle = 'None'
$owner.StartPosition = 'CenterScreen'
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Opacity = 0
$owner.TopMost = $true

$dialog = New-Object System.Windows.Forms.SaveFileDialog
$dialog.Title = '保存会话'
$dialog.Filter = $Filter
$dialog.AddExtension = $true
$dialog.DefaultExt = 'dsproj'
$dialog.OverwritePrompt = $true
$dialog.RestoreDirectory = $true
$dialog.CheckPathExists = $true

if ($Initial -ne '') {
    try {
        $dialog.InitialDirectory = [System.IO.Path]::GetDirectoryName($Initial)
        $dialog.FileName = [System.IO.Path]::GetFileName($Initial)
    } catch {
        # 路径不合法就不预填，交给用户自己选
    }
}

$result = ''
try {
    $owner.Show()
    $owner.Activate()
    $shown = $dialog.ShowDialog($owner)
    if ($shown -eq [System.Windows.Forms.DialogResult]::OK) {
        $result = $dialog.FileName
    }
} finally {
    $dialog.Dispose()
    $owner.Close()
    $owner.Dispose()
}

$line = 'RESULT:' + $result
if ($ResultFile -ne '') {
    try {
        [System.IO.File]::WriteAllText($ResultFile, $line, (New-Object System.Text.UTF8Encoding($false)))
    } catch {
        # 写不了结果文件就只靠 stdout
    }
}
Write-Output $line
