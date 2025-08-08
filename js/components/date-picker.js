// date-picker.js 파일

/**
 * 날짜 범위 선택기를 초기화하고 관련 이벤트를 처리하는 클래스
 * @param {string} inputId - 날짜 입력 필드의 ID
 * @param {function} onDateSelect - 날짜가 선택되었을 때 실행될 콜백 함수
 */
export class DateRangePicker {
  constructor(inputId, onDateSelect) {
    this.inputEl = document.getElementById(inputId);
    this.onDateSelect = onDateSelect;
    this.init();
  }

  init() {
    if (!this.inputEl) {
      console.error(`Input element with ID '${this.inputId}' not found.`);
      return;
    }

    // 키보드 입력 이벤트 리스너
    this.inputEl.addEventListener("input", this.handleInput.bind(this));
    this.inputEl.addEventListener("keydown", this.handleKeydown.bind(this));

    // 날짜 선택 후 실행될 초기 로직
    this.selectInitialDates();
  }

  // 숫자만 남기고, 지정된 형식으로 자동 변환
  handleInput(e) {
    let value = e.target.value.replace(/[^\d-]/g, "");
    let formattedValue = "";

    // "YYYYMMDD" -> "YYYY.MM.DD"
    // "YYYYMMDD-YYYYMMDD" -> "YYYY.MM.DD - YYYY.MM.DD"
    if (value.length > 8) {
      // 8자 이상 입력 시 (시작일-종료일)
      const startDatePart = value.substring(0, 8);
      const endDatePart = value.substring(8, 16);
      if (startDatePart.length === 8) {
        formattedValue += `${startDatePart.substring(
          0,
          4
        )}.${startDatePart.substring(4, 6)}.${startDatePart.substring(6, 8)}`;
      }
      if (endDatePart.length > 0) {
        formattedValue += ` - `;
        if (endDatePart.length >= 8) {
          formattedValue += `${endDatePart.substring(
            0,
            4
          )}.${endDatePart.substring(4, 6)}.${endDatePart.substring(6, 8)}`;
        } else {
          formattedValue += endDatePart;
        }
      }
    } else if (value.length > 0) {
      // 8자 이하 입력 시 (시작일)
      formattedValue = value.substring(0, 4);
      if (value.length >= 5) formattedValue += `.${value.substring(4, 6)}`;
      if (value.length >= 7) formattedValue += `.${value.substring(6, 8)}`;
    }

    e.target.value = formattedValue;
  }

  // Enter 키를 눌렀을 때 콜백 함수 실행
  handleKeydown(e) {
    if (e.key === "Enter") {
      const inputVal = this.inputEl.value;
      const dates = this.parseDateRange(inputVal);
      if (dates) {
        this.onDateSelect(dates.startDate, dates.endDate);
      } else {
        alert("올바른 날짜 형식을 입력해주세요 (예: YYYY.MM.DD - YYYY.MM.DD)");
      }
    }
  }

  // "YYYY.MM.DD - YYYY.MM.DD" 형식의 문자열을 Date 객체로 변환
  parseDateRange(dateStr) {
    const parts = dateStr.split(" - ");
    if (parts.length === 2) {
      const startDate = this.parseDate(parts[0]);
      const endDate = this.parseDate(parts[1]);
      return startDate && endDate ? { startDate, endDate } : null;
    } else if (parts.length === 1 && dateStr.length === 10) {
      const date = this.parseDate(parts[0]);
      return date ? { startDate: date, endDate: date } : null;
    }
    return null;
  }

  // "YYYY.MM.DD" 형식의 문자열을 Date 객체로 변환
  parseDate(dateStr) {
    const [year, month, day] = dateStr.split(".").map(Number);
    const date = new Date(year, month - 1, day);
    return date instanceof Date && !isNaN(date) ? date : null;
  }

  // 페이지 로드 시 오늘 날짜로 초기 선택
  selectInitialDates() {
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, "0");
    const day = String(today.getDate()).padStart(2, "0");
    const todayStr = `${year}.${month}.${day}`;
    this.inputEl.value = todayStr + " - " + todayStr;

    // 초기 로딩 시 콜백 함수를 호출하여 데이터 로드
    this.onDateSelect(today, today);
  }
}
