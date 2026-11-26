#!/data/data/com.termux/files/usr/bin/bash
# מנתק את שעון הגלקסי כשהסוללה מתחת ל-30% (ולא בטעינה)
# מחבר מחדש מעל 40%, או בטעינה מעל 10%
# חסכוני: קריאה אחת ל-rish בכל ריצה רגילה, בלי תהליכים שנשארים ברקע
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

B=$(rish -c "dumpsys battery" 2>/dev/null)
L=$(echo "$B" | awk '/^ *level:/{print $2; exit}')
echo "$L" | grep -qE '^[0-9]+$' || exit 0
echo "$B" | grep -qE '(AC|USB|Wireless) powered: true' && CH=1 || CH=0

if [ "$L" -lt 30 ] && [ "$CH" = 0 ] && [ ! -f "$F" ]; then
  rish -c "pm disable-user --user 0 $P" >/dev/null 2>&1 && touch "$F" && note 'השעון נותק' "הסוללה ב-$L אחוז. יתחבר לבד מעל 40 או בטעינה"
elif [ -f "$F" ] && { [ "$L" -ge 40 ] || { [ "$CH" = 1 ] && [ "$L" -gt 10 ]; }; }; then
  rish -c "pm enable $P" >/dev/null 2>&1 && rm -f "$F" && touch "$R"
fi

# חיבור מחדש: מעיר את אפליקציית השעון רק כשהמסך כבוי, כדי לא להפריע
if [ -f "$R" ] && rish -c "dumpsys power" | grep -q "mWakefulness=Asleep"; then
  wake
  sleep 5
  rish -c "input keyevent KEYCODE_HOME" >/dev/null 2>&1
  rm -f "$R"
  note 'השעון חובר מחדש' "הסוללה ב-$L אחוז"
fi
