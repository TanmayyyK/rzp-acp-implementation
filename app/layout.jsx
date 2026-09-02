import './globals.css';

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="bg-black text-white m-0 p-0 overflow-hidden">
        {children}
      </body>
    </html>
  );
}
