$ErrorActionPreference = 'Stop'
$WS = 'C:\Users\lamau\.minimax\sessions\mvs_d8bd37f6153242e68970dafd7717998f\workspace'

function Replace-Block {
  param([string]$Path, [string]$Old, [string]$New, [string]$Label)
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  $text = [System.Text.Encoding]::UTF8.GetString($bytes)
  $parts = $Old -split "`r?`n"
  $pattern = (($parts | ForEach-Object { [regex]::Escape($_) }) -join '\r?\n')
  $m = [regex]::Match($text, $pattern)
  if (-not $m.Success) { Write-Output ("  -- {0,-22} (not present)" -f $Label); return }
  $nl = "`r`n"
  if (-not $m.Value.Contains("`r`n")) { $nl = "`n" }
  $newText = $New.Replace("`n", $nl)
  $text = $text.Remove($m.Index, $m.Length).Insert($m.Index, $newText)
  [System.IO.File]::WriteAllBytes($Path, (New-Object System.Text.UTF8Encoding($false)).GetBytes($text))
  Write-Output ("  OK {0,-22} [{1}]" -f $Label, $(if ($nl -eq "`r`n") { 'CRLF' } else { 'LF' }))
}

Write-Output 'index.html:'
Replace-Block -Path "$WS\index.html" -Label 'declare URL fetch' -Old @'
      if (/^https?:\/\//i.test(text.trim())) {
        els.parseStatus.textContent = 'Fetching URL…';
        fetch(text.trim())
'@ -New @'
      if (/^https?:\/\//i.test(text.trim())) {
        var fetchUrl = text.trim();
        els.parseStatus.textContent = 'Fetching URL…';
        // Tell the privacy verifier about this request. Ad scripts can replace
        // window.fetch, so the verifier's own wrapper may never see it.
        if (window.HopPrivacy && window.HopPrivacy.noteRequest) {
          window.HopPrivacy.noteRequest('GET', fetchUrl);
        }
        fetch(fetchUrl)
'@

# hop-common.js changed, so the version query must change too.
$OLDV = 'hop-common.js?v=20261112-2'
$NEWV = 'hop-common.js?v=20261112-3'
$n = 0
foreach ($f in (Get-ChildItem "$WS\*.html" | Sort-Object Name)) {
  $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
  $text = [System.Text.Encoding]::UTF8.GetString($bytes)
  if ($text.Contains($OLDV)) {
    $text = $text.Replace($OLDV, $NEWV)
    [System.IO.File]::WriteAllBytes($f.FullName, (New-Object System.Text.UTF8Encoding($false)).GetBytes($text))
    $n++
  }
}
Write-Output ("bumped script version to 20261112-3 in {0} pages" -f $n)

$readme = "$WS\VERSION.txt"
[System.IO.File]::WriteAllText($readme, @"
hop-common.js cache version

GitHub Pages serves .js with Cache-Control: max-age=14400 (4 hours).
Every page loads the shared runtime as:

  <script src="hop-common.js?v=20261112-3"></script>

When hop-common.js changes, bump the version on all 20 pages in the same
commit, otherwise visitors keep running the previous copy for up to four
hours - which matters most for the privacy verifier, the one file whose
logic decides whether the site claims your data stayed local.

Current version: 20261112-3
"@, (New-Object System.Text.UTF8Encoding($false)))
Write-Output 'wrote VERSION.txt'
