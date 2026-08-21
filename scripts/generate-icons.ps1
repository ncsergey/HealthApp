Add-Type -AssemblyName System.Drawing

$iconsPath = Join-Path $PSScriptRoot '..\icons'
New-Item -ItemType Directory -Force -Path $iconsPath | Out-Null

function New-MyHealthIcon {
    param([int]$Size, [string]$OutputPath)

    $bitmap = [System.Drawing.Bitmap]::new($Size, $Size)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

    $bounds = [System.Drawing.Rectangle]::new(0, 0, $Size, $Size)
    $start = [System.Drawing.ColorTranslator]::FromHtml('#167b68')
    $finish = [System.Drawing.ColorTranslator]::FromHtml('#0b5f53')
    $brush = [System.Drawing.Drawing2D.LinearGradientBrush]::new($bounds, $start, $finish, 45)
    $graphics.FillRectangle($brush, $bounds)

    $haloBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(38, 255, 255, 255))
    $haloInset = [int]($Size * 0.18)
    $haloSize = $Size - (2 * $haloInset)
    $graphics.FillEllipse($haloBrush, $haloInset, $haloInset, $haloSize, $haloSize)

    $penWidth = [Math]::Max(12, [int]($Size * 0.105))
    $pen = [System.Drawing.Pen]::new([System.Drawing.Color]::White, $penWidth)
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $center = $Size / 2
    $arm = $Size * 0.17
    $graphics.DrawLine($pen, $center - $arm, $center, $center + $arm, $center)
    $graphics.DrawLine($pen, $center, $center - $arm, $center, $center + $arm)

    $highlight = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(32, 255, 255, 255))
    $graphics.FillEllipse($highlight, [int]($Size * 0.14), [int]($Size * 0.11), [int]($Size * 0.34), [int]($Size * 0.22))

    $bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $highlight.Dispose()
    $pen.Dispose()
    $haloBrush.Dispose()
    $brush.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
}

New-MyHealthIcon -Size 192 -OutputPath (Join-Path $iconsPath 'icon-192.png')
New-MyHealthIcon -Size 512 -OutputPath (Join-Path $iconsPath 'icon-512.png')
