export function Cloudscape() {
  return (
    <svg
      className="cloudscape"
      viewBox="0 0 800 1000"
      preserveAspectRatio="xMidYMid slice"
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient
          id="sky"
          x1="400"
          y1="0"
          x2="400"
          y2="1000"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#132e87" />
          <stop offset=".52" stopColor="#315bdb" />
          <stop offset="1" stopColor="#a7c9f3" />
        </linearGradient>
        <linearGradient
          id="cloud"
          x1="400"
          y1="480"
          x2="400"
          y2="1000"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#e8f1ff" stopOpacity=".75" />
          <stop offset="1" stopColor="#e8f1ff" stopOpacity=".08" />
        </linearGradient>
      </defs>
      <path fill="url(#sky)" d="M0 0h800v1000H0z" />
      <circle cx="650" cy="430" r="180" stroke="white" strokeOpacity=".07" />
      <circle cx="650" cy="430" r="240" stroke="white" strokeOpacity=".07" />
      <circle cx="650" cy="430" r="300" stroke="white" strokeOpacity=".07" />
      <path
        d="M-100 950c140-150 205-46 335-129 132-83 148-200 306-172 158 28 185-120 350-140v631H-100Z"
        fill="url(#cloud)"
      />
      {Array.from({ length: 19 }, (_, i) => (
        <path
          key={i}
          d={`M-100 ${950 + i * 15}c140-150 205-46 335-129 132-83 148-200 306-172 158 28 185-120 350-140`}
          stroke="#eef6ff"
          strokeOpacity={0.38 - i * 0.012}
          strokeWidth="1"
        />
      ))}
      <path
        d="M-100 900c160-100 250 55 410-30 160-85 220-160 560-70v200H-100Z"
        fill="#e0edff"
        fillOpacity=".14"
      />
    </svg>
  );
}
