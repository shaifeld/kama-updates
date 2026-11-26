#!/data/data/com.termux/files/usr/bin/bash
# מנתק את שעון הגלקסי כשהסוללה מתחת ל-30% ומחבר מחדש מעל 40%
P=com.samsung.wearable.watch7plugin
M=com.samsung.android.app.watchmanager
F=$HOME/.watch_off
R=$HOME/.watch_reconnect
note(){ rish -c "cmd notification post -t '$1' watchsaver '$2'" >/dev/null 2>&1; }
wake(){ rish -c "monkey -p $M -c android.intent.category.LAUNCHER 1" >/dev/null 2>&1; }

if [ "$1" = now ]; then
  rish -c "pm enable $P" >/dev/null 2>&1
  rm -f "$F" "$R"
  wake
  if rish -c "pm list packages -d" | grep -q "$P"; then echo "ההדלקה נכשלה"; else echo "השעון הודלק ומתחבר"; fi
  exit 0
fi

L=$(rish -c "dumpsys battery" | awk '/^ *level:/{print $2; exit}')
echo "$L" | grep -qE '^[0-9]+$' || exit 0

if [ "$L" -lt 30 ] && [ ! -f "$F" ]; then
  rish -c "pm disable-user --user 0 $P" >/dev/null 2>&1 && touch "$F" && note 'השעון נותק' "הסוללה ב-$L אחוז. יתחבר לבד מעל 40"
elif [ "$L" -ge 40 ] && [ -f "$F" ]; then
  rish -c "pm enable $P" >/dev/null 2>&1 && rm -f "$F" && touch "$R"
fi

# חיבור מחדש אוטומטי: מעיר את אפליקציית השעון רק כשהמסך כבוי, כדי לא להפריע
if [ -f "$R" ] && rish -c "dumpsys power" | grep -q "mWakefulness=Asleep"; then
  wake
  sleep 5
  rish -c "input keyevent KEYCODE_HOME" >/dev/null 2>&1
  rm -f "$R"
  note 'השעון חובר מחדש' "הסוללה ב-$L אחוז"
fi
