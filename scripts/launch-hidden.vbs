' WorkBuddy Skins - silent launcher (no console window flash).
' Runs apply.ps1 hidden: starts WorkBuddy with CDP if needed, then applies the skin.
' Used as the target for hijacked Start Menu shortcut / Run key (see install-launcher.ps1).
Dim fso, sh, dir
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & dir & "\apply.ps1""", 0, False
