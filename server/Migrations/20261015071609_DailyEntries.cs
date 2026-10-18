using System;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Damadama.Migrations
{
    public partial class DailyEntries : Migration
    {
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "DailyEntries",
                columns: table => new
                {
                    HabitId = table.Column<Guid>(type: "uuid", nullable: false),
                    CalendarDate = table.Column<DateOnly>(type: "date", nullable: false),
                    Result = table.Column<int>(type: "integer", nullable: false),
                    EditedAtTicks = table.Column<long>(type: "bigint", nullable: false),
                    Best = table.Column<string>(type: "text", nullable: false),
                    Better = table.Column<string>(type: "text", nullable: false),
                    Good = table.Column<string>(type: "text", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_DailyEntries", x => new { x.HabitId, x.CalendarDate });
                    table.CheckConstraint("EntryResult", "\"Result\" BETWEEN 0 AND 4");
                    table.ForeignKey(
                        name: "FK_DailyEntries_Habits_HabitId",
                        column: x => x.HabitId,
                        principalTable: "Habits",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });
        }

        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "DailyEntries");
        }
    }
}
