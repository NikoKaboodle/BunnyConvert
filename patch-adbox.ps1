# ============================================================
# patch-adbox.ps1 — reserve the ad space on a wrapper the ad
# network does not touch.
#
# The ad network rewrites the element that directly contains the
# <ins>, setting "height: auto !important; min-height: 0px
# !important" on it while it measures and fills the slot. An
# important inline declaration beats an important rule in the
# stylesheet, so a min-height on that element is cancelled.
#
# The reservation therefore moves to a wrapper around the ad
# container. The outer element is never rewritten, so the space
# stays reserved whatever the network does inside it.
# ============================================================

$ErrorActionPreference = 'Stop'
$WS = Split-Path -Parent $MyInvocation.MyCommand.Path
$enc = New-Object System.Text.UTF8Encoding $false

# ------------------------------------------------------------
# 1. style.css
# ------------------------------------------------------------
$cssPath = "$WS\style.css"
$css = [System.IO.File]::ReadAllText($cssPath, $enc)

$oldCss = @'
.ad-slot {
  margin: 28px auto;
  max-width: 100%;
  text-align: center;
  display: block;
}
.ad-slot ins.adsbygoogle { display: block; }

/* Slot type 1 - wide horizontal strip, used directly under the trust strip.
   The container is capped at 728px so the unit stays a leaderboard
   (728x90 on desktop, 320x50 on mobile), which fits the reserved box. */
.ad-slot--banner {
  max-width: 728px;
  min-height: 100px;
}
.ad-slot--banner ins.adsbygoogle { min-height: 100px; }

/* Slot type 2 - in-content rectangle between content blocks.
   Column width keeps the unit in the 250-280px band (336x280 desktop,
   300x250 mobile), which fits the reserved height. */
.ad-slot--rect {
  max-width: 336px;
  min-height: 280px;
}
.ad-slot--rect ins.adsbygoogle { min-height: 280px; }
'@

$newCss = @'
.ad-slot {
  margin: 28px auto;
  max-width: 100%;
  text-align: center;
  display: block;
}
.ad-slot ins.adsbygoogle { display: block; }

/* The reserved box. It sits between the ad slot and the <ins>, because
   the ad network rewrites the element that directly contains the <ins> and
   resets its height. The wrapper is left alone, so the space stays
   reserved no matter what the network does inside it. */
.ad-slot__box { display: block; }

/* Slot type 1 - wide horizontal strip, used directly under the trust strip.
   The container is capped at 728px so the unit stays a leaderboard
   (728x90 on desktop, 320x50 on mobile), which fits the reserved box. */
.ad-slot--banner {
  max-width: 728px;
  min-height: 100px;
}
.ad-slot--banner .ad-slot__box { min-height: 100px; }

/* Slot type 2 - in-content rectangle between content blocks.
   Column width keeps the unit in the 250-280px band (336x280 desktop,
   300x250 mobile), which fits the reserved height. */
.ad-slot--rect {
  max-width: 336px;
  min-height: 280px;
}
.ad-slot--rect .ad-slot__box { min-height: 280px; }
'@

if ($css.Contains($newCss)) {
  Write-Output 'style.css: ad wrapper rules already applied'
} elseif ($css.Contains($oldCss)) {
  $css = $css.Replace($oldCss, $newCss)
  [System.IO.File]::WriteAllText($cssPath, $css, $enc)
  Write-Output 'style.css: ad wrapper rules applied'
} else {
  throw 'style.css: ad slot rules not found'
}

# ------------------------------------------------------------
# 2. Pages — wrap the ad in the reserved box
# ------------------------------------------------------------
$dev = @('adversarial.html','regress.html','privacydiag.html','selftest.html')
$pages = Get-ChildItem "$WS\*.html" | Where-Object { $dev -notcontains $_.Name }

$total = 0
foreach ($f in $pages) {
  $text = [System.IO.File]::ReadAllText($f.FullName, $enc)
  if ($text -notmatch '<div class="ad-slot') { continue }
  if ($text -match 'ad-slot__box') {
    Write-Output ("  {0,-34} already wrapped" -f $f.Name)
    continue
  }

  $counter = @{ n = 0 }
  $new = [regex]::Replace($text, '(?s)<div class="ad-slot[^"]*"[^>]*>.*?</div>', {
    param($m)
    $counter.n = $counter.n + 1
    $block = $m.Value
    $wrapped = [regex]::Replace($block, '(?s)([ \t]*)(<ins\b.*?</ins>)\r?\n([ \t]*)(<script>.*?</script>)', {
      param($im)
      $eol = if ($im.Value -match "`r`n") { "`r`n" } else { "`n" }
      $ind = $im.Groups[1].Value
      # Indent every line of the script block by two spaces.
      $scriptBlock = $im.Groups[4].Value
      $scriptLines = $scriptBlock -split "`r?`n"
      $reindented = ($scriptLines | ForEach-Object { '  ' + $_ }) -join $eol
      return $ind + '<div class="ad-slot__box">' + $eol +
             $ind + '  ' + $im.Groups[2].Value + $eol +
             $ind + $reindented + $eol +
             $ind + '</div>'
    })
    if ($wrapped -eq $block) { throw "ad block not matched in $($f.Name)" }
    return $wrapped
  })

  $total += $counter.n
  [System.IO.File]::WriteAllText($f.FullName, $new, $enc)
  Write-Output ("  {0,-34} wrapped {1} slot(s)" -f $f.Name, $count)
}

Write-Output ("ad slots wrapped: $total")
