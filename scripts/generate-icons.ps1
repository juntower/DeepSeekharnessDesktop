[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$resourcePath = Join-Path $workspaceRoot 'resources'
New-Item -ItemType Directory -Force -Path $resourcePath | Out-Null

function New-HarnessBitmap {
  param(
    [Parameter(Mandatory = $true)][int]$Size,
    [Parameter(Mandatory = $true)][System.Drawing.Color]$Color,
    [int]$ActiveBar = -1
  )

  $bitmap = [System.Drawing.Bitmap]::new($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $center = $Size / 2.0
    $points = [System.Drawing.PointF[]]@(
      [System.Drawing.PointF]::new([single]$center, [single]($Size * 0.055)),
      [System.Drawing.PointF]::new([single]($Size * 0.91), [single]($Size * 0.255)),
      [System.Drawing.PointF]::new([single]($Size * 0.91), [single]($Size * 0.745)),
      [System.Drawing.PointF]::new([single]$center, [single]($Size * 0.945)),
      [System.Drawing.PointF]::new([single]($Size * 0.09), [single]($Size * 0.745)),
      [System.Drawing.PointF]::new([single]($Size * 0.09), [single]($Size * 0.255))
    )
    $outerBrush = [System.Drawing.SolidBrush]::new($Color)
    $innerColor = [System.Drawing.Color]::FromArgb(248, 8, 13, 11)
    $innerBrush = [System.Drawing.SolidBrush]::new($innerColor)
    try {
      $graphics.FillPolygon($outerBrush, $points)
      $inset = [single]($Size * 0.105)
      $innerPoints = [System.Drawing.PointF[]]@(
        [System.Drawing.PointF]::new([single]$center, [single]($Size * 0.15)),
        [System.Drawing.PointF]::new([single]($Size * 0.82), [single]($Size * 0.31)),
        [System.Drawing.PointF]::new([single]($Size * 0.82), [single]($Size * 0.69)),
        [System.Drawing.PointF]::new([single]$center, [single]($Size * 0.85)),
        [System.Drawing.PointF]::new([single]($Size * 0.18), [single]($Size * 0.69)),
        [System.Drawing.PointF]::new([single]($Size * 0.18), [single]($Size * 0.31))
      )
      $graphics.FillPolygon($innerBrush, $innerPoints)

      $pen = [System.Drawing.Pen]::new($Color, [single][Math]::Max(1.0, $Size * 0.045))
      $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Square
      $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Square
      try {
        $graphics.DrawLine($pen, [single]($Size * 0.34), [single]($Size * 0.39), [single]($Size * 0.66), [single]($Size * 0.39))
        $graphics.DrawLine($pen, [single]($Size * 0.34), [single]($Size * 0.61), [single]($Size * 0.66), [single]($Size * 0.61))
        $graphics.DrawLine($pen, [single]($Size * 0.5), [single]($Size * 0.30), [single]($Size * 0.5), [single]($Size * 0.70))
      }
      finally {
        $pen.Dispose()
      }

      if ($ActiveBar -ge 0) {
        $barWidth = [single]($Size * 0.13)
        $barHeight = [single]($Size * 0.075)
        $gap = [single]($Size * 0.055)
        $total = (3 * $barWidth) + (2 * $gap)
        $startX = [single](($Size - $total) / 2.0)
        $y = [single]($Size * 0.86)
        for ($index = 0; $index -lt 3; $index++) {
          $barColor = if ($index -eq $ActiveBar) { $Color } else { [System.Drawing.Color]::FromArgb(120, 99, 245, 208) }
          $barBrush = [System.Drawing.SolidBrush]::new($barColor)
          try {
            $graphics.FillRectangle($barBrush, [single]($startX + ($index * ($barWidth + $gap))), $y, $barWidth, $barHeight)
          }
          finally {
            $barBrush.Dispose()
          }
        }
      }
    }
    finally {
      $outerBrush.Dispose()
      $innerBrush.Dispose()
    }
    return $bitmap
  }
  catch {
    $bitmap.Dispose()
    throw
  }
  finally {
    $graphics.Dispose()
  }
}

function Save-HarnessIcon {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][System.Drawing.Color]$Color,
    [int]$Size = 32,
    [int]$ActiveBar = -1
  )
  $target = Join-Path $resourcePath $Name
  $bitmap = New-HarnessBitmap -Size $Size -Color $Color -ActiveBar $ActiveBar
  try {
    $bitmap.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
  }
  finally {
    $bitmap.Dispose()
  }
}

$signal = [System.Drawing.Color]::FromArgb(255, 99, 245, 208)
$idle = [System.Drawing.Color]::FromArgb(255, 126, 147, 137)
$warning = [System.Drawing.Color]::FromArgb(255, 255, 180, 84)
$danger = [System.Drawing.Color]::FromArgb(255, 255, 107, 82)

Save-HarnessIcon -Name 'tray-idle.png' -Color $idle
Save-HarnessIcon -Name 'tray-running.png' -Color $signal
Save-HarnessIcon -Name 'tray-warning.png' -Color $warning
Save-HarnessIcon -Name 'tray-error.png' -Color $danger
Save-HarnessIcon -Name 'tray-busy-1.png' -Color $signal -ActiveBar 0
Save-HarnessIcon -Name 'tray-busy-2.png' -Color $signal -ActiveBar 1
Save-HarnessIcon -Name 'tray-busy-3.png' -Color $signal -ActiveBar 2
Save-HarnessIcon -Name 'icon.png' -Color $signal -Size 256
Write-Host "Generated tray and application icons in $resourcePath"
